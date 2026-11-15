import { supabase } from '@/lib/supabase';

const OWNER = 'studentgo-push-owner';
export function supportsPush(): boolean {
  return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
async function registration(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('La app se está actualizando. Cierra sus pestañas y vuelve a abrirla.')), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function request(body: object): Promise<{ enabled?: boolean; publicKey?: string; queued?: boolean }> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const { data, error } = await supabase.functions.invoke('notificaciones-push', { body, signal: controller.signal });
    if (error) {
      let message = 'No se pudo conectar con las notificaciones. Revisa tu conexión y la configuración del servicio.';
      if (error.context instanceof Response) {
        const result = await error.context.clone().json().catch(() => null);
        if (typeof result?.message === 'string') message = result.message;
      }
      throw new Error(message);
    }
    return data;
  } finally { clearTimeout(timer); }
}
function rememberOwner(userId: string | null) {
  try { if (userId) localStorage.setItem(OWNER, userId); else localStorage.removeItem(OWNER); } catch { /* Storage can be disabled. */ }
}
export async function pushStatus(): Promise<{ enabled: boolean; subscribed: boolean }> {
  if (!supportsPush()) return { enabled: false, subscribed: false };
  const reg = await navigator.serviceWorker.getRegistration('/');
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return { enabled: false, subscribed: false };
  const result = await request({ action: 'status', endpoint: subscription.endpoint });
  return { enabled: result.enabled === true && Notification.permission === 'granted', subscribed: true };
}
export async function enablePush(userId: string): Promise<void> {
  if (!supportsPush()) throw new Error('Este navegador no permite notificaciones push. Prueba desde la app instalada o un navegador compatible.');
  if (!navigator.onLine) throw new Error('Conéctate a internet para activar las notificaciones.');
  // Request permission directly from the user's button click, before any network await.
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') throw new Error('Las notificaciones no están permitidas. Puedes cambiarlo en los permisos del sitio.');
  const { publicKey } = await request({ action: 'key' });
  if (!publicKey || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error('Falta configurar la clave pública de notificaciones.');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const reg = await registration();
  let subscription = await reg.pushManager.getSubscription();
  if (subscription) {
    const { enabled } = await request({ action: 'status', endpoint: subscription.endpoint });
    const oldKey = subscription.options.applicationServerKey;
    const keyMatches = oldKey && new Uint8Array(oldKey).every((value, i) => value === key[i]) && oldKey.byteLength === key.length;
    if (!enabled || !keyMatches) {
      await request({ action: 'unsubscribe', endpoint: subscription.endpoint });
      if (!await subscription.unsubscribe()) throw new Error('No se pudo renovar la suscripción. Intenta desactivarla primero.');
      subscription = null;
    }
  }
  const current = subscription ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  try {
    await request({ action: 'subscribe', subscription: current.toJSON() });
    rememberOwner(userId);
  } catch (error) {
    if (!subscription) await current.unsubscribe().catch(() => false);
    throw error;
  }
}
export async function disablePush(): Promise<void> {
  if (!supportsPush()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) { rememberOwner(null); return; }
  // Remove from provider even if the application server is temporarily unavailable.
  const server = request({ action: 'unsubscribe', endpoint: subscription.endpoint }).then(() => true, () => false);
  const removed = await subscription.unsubscribe();
  const serverRemoved = await server;
  if (!removed && !serverRemoved) throw new Error('No se pudieron desactivar. Bloquea las notificaciones desde los permisos del sitio.');
  rememberOwner(null);
}
export async function resetPushForAccount(userId: string | null): Promise<void> {
  if (!supportsPush()) return;
  let previous: string | null = null;
  try { previous = localStorage.getItem(OWNER); } catch { return; }
  if (previous && previous !== userId) await disablePush();
}
export async function testPush(): Promise<void> {
  const reg = await registration(); const subscription = await reg.pushManager.getSubscription();
  if (!subscription) throw new Error('Activa primero las notificaciones.');
  const result = await request({ action: 'test', endpoint: subscription.endpoint });
  if (!result.queued) throw new Error('No se pudo programar la prueba.');
}
