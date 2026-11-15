import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.119.0';
import { sameSecret, validEndpoint, validSubscription, type Subscription } from './validation.ts';
import type { PushConfig, PushMessage } from './send.ts';

type Dependencies = {
  db: SupabaseClient;
  env: (key: string) => string | undefined;
  send: (subscription: Subscription, message: PushMessage, config: PushConfig) => Promise<number>;
  background: (task: Promise<unknown>) => void;
  delay: () => Promise<void>;
};
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: cors });
class RequestError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new RequestError('Falta la solicitud.');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 8192) { await reader.cancel(); throw new RequestError('Solicitud demasiado grande.', 413); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new RequestError('Solicitud inválida.'); }
}

export function createPushHandler({ db, env, send, background, delay }: Dependencies) {
  function config(): PushConfig {
    const publicKey = env('PUSH_VAPID_PUBLIC_KEY'); const privateKey = env('PUSH_VAPID_PRIVATE_KEY');
    const subject = env('PUSH_VAPID_SUBJECT');
    if (!publicKey || !privateKey || !subject) throw new RequestError('Las notificaciones aún no están configuradas.', 503);
    return { publicKey, privateKey, subject };
  }
  async function deliver(userId: string, message: PushMessage, endpoint?: string) {
    const settings = config();
    let query = db.from('web_push_subscriptions').select('id, endpoint, p256dh, auth').eq('user_id', userId);
    if (endpoint) query = query.eq('endpoint', endpoint);
    const { data, error } = await query.limit(10);
    if (error) throw new Error('Subscription lookup failed');
    const results = await Promise.all((data ?? []).map(async row => {
      try {
        const status = await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, message, settings);
        if (status === 404 || status === 410) {
          await db.from('web_push_subscriptions').delete().eq('id', row.id).eq('user_id', userId);
          return 'expired';
        }
        return status >= 200 && status < 300 ? 'accepted' : 'failed';
      } catch { return 'failed'; }
    }));
    return { accepted: results.filter(r => r === 'accepted').length, failed: results.filter(r => r === 'failed').length, expired: results.filter(r => r === 'expired').length };
  }
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return reply({ message: 'Método no permitido.' }, 405);
    try {
      // Database Webhook is a separate authenticated path, never trusted by its JSON alone.
      if (request.headers.has('x-push-hook-secret')) {
        if (!sameSecret(env('PUSH_WEBHOOK_SECRET'), request.headers.get('x-push-hook-secret'))) return reply({ message: 'No autorizado.' }, 401);
        const body = await readBody(request);
        const record = body.record as { id?: unknown } | undefined;
        if (body.type !== 'INSERT' || body.table !== 'notifications' || body.schema !== 'public' ||
            typeof record?.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.id)) throw new RequestError('Evento inválido.');
        // Re-read the recipient; do not accept recipient or message text from the webhook payload.
        const { data: notice, error } = await db.from('notifications').select('id, user_id').eq('id', record.id).maybeSingle();
        if (error) throw new Error('Notification lookup failed');
        if (!notice) return reply({ message: 'Aviso no encontrado.' }, 404);
        const result = await deliver(notice.user_id, { kind: 'notice', tag: 'notice-' + notice.id });
        return reply(result, result.failed ? 502 : 200);
      }
      const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) return reply({ message: 'Inicia sesión.' }, 401);
      const { data: { user }, error: authError } = await db.auth.getUser(token);
      if (authError || !user) return reply({ message: 'Tu sesión ha expirado.' }, 401);
      const body = await readBody(request);
      if (body.action === 'key') return reply({ publicKey: config().publicKey });
      if (body.action === 'subscribe') {
        config();
        if (!validSubscription(body.subscription)) throw new RequestError('Suscripción de navegador inválida o no compatible.');
        const s = body.subscription;
        const { error } = await db.rpc('register_web_push', { p_user: user.id, p_endpoint: s.endpoint, p_p256dh: s.keys.p256dh, p_auth: s.keys.auth });
        if (error?.code === '23505') throw new RequestError('Desactiva las notificaciones de este navegador y vuelve a activarlas.', 409);
        if (error?.code === '23514') throw new RequestError('Llegaste al límite de diez dispositivos.', 409);
        if (error) throw new Error('Subscription registration failed');
        return reply({ enabled: true });
      }
      if (!['status', 'unsubscribe', 'test'].includes(String(body.action)) || !validEndpoint(body.endpoint)) throw new RequestError('Solicitud inválida.');
      if (body.action === 'unsubscribe') {
        const { error } = await db.from('web_push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', body.endpoint);
        if (error) throw new Error('Subscription removal failed');
        return reply({ enabled: false });
      }
      const { data: subscription, error } = await db.from('web_push_subscriptions').select('id').eq('user_id', user.id).eq('endpoint', body.endpoint).maybeSingle();
      if (error) throw new Error('Subscription lookup failed');
      if (body.action === 'status') return reply({ enabled: !!subscription });
      if (!subscription) throw new RequestError('Activa las notificaciones en este navegador primero.', 409);
      config();
      const { data: allowed, error: limitError } = await db.rpc('reserve_web_push_test', { p_user: user.id });
      if (limitError) throw new Error('Rate limit unavailable');
      if (!allowed) throw new RequestError('Espera un minuto antes de pedir otra prueba.', 429);
      const endpoint = body.endpoint;
      background((async () => {
        await delay();
        const result = await deliver(user.id, { kind: 'test', tag: 'studentgo-push-test' }, endpoint);
        // Do not log subscription endpoints, keys, names or notification contents.
        console.info('push-test-result', result);
      })().catch(() => console.error('push-test-failed')));
      return reply({ queued: true, delaySeconds: 15 }, 202);
    } catch (error) {
      if (error instanceof RequestError) return reply({ message: error.message }, error.status);
      console.error('push-request-failed');
      return reply({ message: 'No se pudo completar la operación de notificaciones. Intenta de nuevo.' }, 503);
    }
  };
}
