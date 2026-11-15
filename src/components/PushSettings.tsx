import { useCallback, useEffect, useState } from 'react';
import { disablePush, enablePush, pushStatus, supportsPush, testPush } from '@/lib/push';

export default function PushSettings({ userId }: { userId: string }) {
  const supported = supportsPush();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [message, setMessage] = useState('');
  const [permission, setPermission] = useState(supported ? Notification.permission : 'default');
  const refresh = useCallback(async () => {
    if (!supported) { setChecking(false); return; }
    setPermission(Notification.permission);
    try { const status = await pushStatus(); setEnabled(status.enabled); }
    catch (error) { setEnabled(false); setMessage(error instanceof Error ? error.message : 'No se pudo consultar el estado.'); }
    finally { setChecking(false); }
  }, [supported]);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [refresh]);
  async function run(action: 'enable' | 'disable' | 'test') {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      if (action === 'enable') { await enablePush(userId); setEnabled(true); setMessage('Notificaciones activadas en este navegador.'); }
      if (action === 'disable') { await disablePush(); setEnabled(false); setMessage('Notificaciones desactivadas en este navegador.'); }
      if (action === 'test') { await testPush(); setMessage('Prueba programada: cierra esta pestaña, deja el navegador abierto y espera unos 15 segundos. La prueba se confirma cuando recibas el aviso.'); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'No se pudo completar la operación.'); }
    finally { setBusy(false); if (supported) setPermission(Notification.permission); }
  }
  return <section className="empty-panel" aria-label="Notificaciones del dispositivo" style={{ textAlign: 'left', marginBottom: 20 }}>
    <h2>Notificaciones en este dispositivo</h2>
    <p>Recibe un aviso de StudentGo aunque cierres su pestaña. El aviso no mostrará datos de tus viajes ni de tu credencial.</p>
    {!supported ? <p>Este navegador no ofrece esta función. En iPhone o iPad, prueba desde la app añadida a la pantalla de inicio.</p> : <>
      <p>{checking ? 'Consultando estado…' : enabled ? 'Activadas en este navegador.' : 'Desactivadas en este navegador.'}</p>
      {permission === 'denied' && <p>El permiso está bloqueado. Abre los permisos del sitio, permite las notificaciones y vuelve aquí.</p>}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button className="primary-button" disabled={busy || checking || permission === 'denied' || enabled} onClick={() => void run('enable')}>Activar notificaciones</button>
        <button className="secondary-button" disabled={busy || checking || !enabled} onClick={() => void run('test')}>Enviar prueba en 15 segundos</button>
        <button className="secondary-button" disabled={busy || checking} onClick={() => void run('disable')}>Desactivar</button>
      </div>
    </>}
    {message && <p role="status" style={{ marginTop: 12 }}>{message}</p>}
  </section>;
}
