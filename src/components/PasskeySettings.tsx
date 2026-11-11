import { useCallback, useEffect, useRef, useState } from 'react';
import type { PasskeyListItem } from '@supabase/supabase-js';
import { Fingerprint, KeyRound, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { passkeyErrorMessage } from '@/lib/passkeys';
import { registerDevicePasskey } from '@/lib/passkeyClient';
import { usePasskeySupport } from '@/lib/usePasskeySupport';
import './passkeys.css';

export default function PasskeySettings({ userId, onRegistered }: { userId: string; onRegistered?: () => void }) {
  const support = usePasskeySupport();
  const [keys, setKeys] = useState<PasskeyListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error: listError } = await supabase.auth.passkey.list();
      if (listError) throw listError;
      if (active.current) { setKeys(data ?? []); setError(''); }
    } catch (failure) {
      if (active.current) setError(passkeyErrorMessage(failure));
    } finally {
      if (active.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; controller.current?.abort(); };
  }, [refresh, userId]);

  async function register() {
    if (busy || controller.current || !support?.supported) return;
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true); setError(''); setNotice('');
    try {
      await registerDevicePasskey(attempt.signal);
      if (active.current) {
        setNotice('Clave de acceso activada. Ya puedes usarla la próxima vez que inicies sesión.');
        await refresh();
        onRegistered?.();
      }
    } catch (failure) {
      if (active.current) setError(passkeyErrorMessage(failure));
    } finally {
      controller.current = null;
      if (active.current) setBusy(false);
    }
  }

  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: deleteError } = await supabase.auth.passkey.delete({ passkeyId: id });
      if (deleteError) throw deleteError;
      setKeys((current) => current.filter((key) => key.id !== id));
      setRemoving(null);
      setNotice('Clave eliminada de tu cuenta. Puedes quitarla también del gestor de claves del dispositivo.');
    } catch (failure) { setError(passkeyErrorMessage(failure)); }
    finally { setBusy(false); }
  }

  async function rename(id: string, name: string) {
    if (busy || !name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: updateError } = await supabase.auth.passkey.update({ passkeyId: id, friendlyName: name.trim() });
      if (updateError) throw updateError;
      if (data) setKeys((current) => current.map((key) => key.id === id ? data : key));
      setNotice('Nombre actualizado.');
    } catch (failure) { setError(passkeyErrorMessage(failure)); }
    finally { setBusy(false); }
  }

  return <section className="passkey-settings card-surface" aria-label="Claves de acceso">
    <div className="passkey-heading"><Fingerprint size={28} aria-hidden="true" /><div><h2>Acceso con huella o rostro</h2><p>Activa una clave de acceso para entrar sin escribir tu contraseña.</p></div></div>
    <p className="passkey-help">Tu dispositivo puede usar huella, rostro o PIN. Student Go no recibe ni almacena tus datos biométricos.</p>
    {support && !support.supported && <p className="passkey-status" role="status">{support.reason}</p>}
    {support?.supported && !support.platformAvailable && <p className="passkey-help">No se detectó un verificador integrado. El navegador puede ofrecer otro dispositivo o una llave de seguridad.</p>}
    {error && <p className="passkey-status passkey-error" role="alert">{error}</p>}
    {notice && <p className="passkey-status passkey-success" role="status">{notice}</p>}
    <button type="button" className="passkey-button" disabled={busy || loading || !support?.supported} onClick={() => { void register(); }}><Fingerprint size={20} aria-hidden="true" />{busy ? 'Procesando…' : 'Activar en este dispositivo'}</button>
    {busy && controller.current && <button type="button" className="passkey-link" onClick={() => controller.current?.abort()}>Cancelar verificación</button>}
    <p className="passkey-help">Conserva tu contraseña para recuperar el acceso si pierdes tus claves.</p>
    {loading ? <p role="status">Consultando claves de acceso…</p> : <>
      <div className="passkey-list-title"><h3>Tus claves de acceso</h3><button type="button" className="passkey-link" disabled={busy} onClick={() => { void refresh(); }}>Actualizar</button></div>
      {!keys.length && !error && <p className="passkey-help">Todavía no has activado ninguna.</p>}
      <ul className="passkey-list">{keys.map((key) => <li key={key.id}>
        <KeyRound size={19} aria-hidden="true" />
        <div className="passkey-item"><PasskeyName item={key} disabled={busy} onSave={(name) => { void rename(key.id, name); }} />
          <small>Creada: {new Date(key.created_at).toLocaleDateString('es-MX')}{key.last_used_at ? ` · Último acceso: ${new Date(key.last_used_at).toLocaleDateString('es-MX')}` : ''}</small>
          {removing === key.id ? <div className="passkey-delete-confirm"><p>Esta clave dejará de servir para entrar. Podrás usar otra clave o tu contraseña.</p><button type="button" disabled={busy} onClick={() => { void remove(key.id); }}>Eliminar clave</button><button type="button" disabled={busy} onClick={() => setRemoving(null)}>Conservar</button></div> : <button type="button" className="passkey-link" disabled={busy} onClick={() => setRemoving(key.id)}><Trash2 size={14} /> Quitar clave</button>}
        </div>
      </li>)}</ul>
    </>}
  </section>;
}

function PasskeyName({ item, disabled, onSave }: { item: PasskeyListItem; disabled: boolean; onSave: (name: string) => void }) {
  const [name, setName] = useState(item.friendly_name ?? 'Mi clave de acceso');
  return <form className="passkey-name" onSubmit={(event) => { event.preventDefault(); onSave(name); }}>
    <input aria-label="Nombre de la clave de acceso" value={name} maxLength={120} required disabled={disabled} onChange={(event) => setName(event.target.value)} />
    <button type="submit" disabled={disabled || !name.trim() || name === item.friendly_name}>Guardar nombre</button>
  </form>;
}
