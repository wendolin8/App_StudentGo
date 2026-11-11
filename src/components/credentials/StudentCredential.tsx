import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { offlineNotice, useOnline } from './useOnline';
import CredentialFields from './CredentialFields';
import { emptyPhotos, preparePhoto, type Photos } from './images';

type StateRow = { status: 'PENDING' | 'APPROVED' | 'REJECTED'; reason: string | null };
const labels = { PENDING: 'Pendiente de revisión', APPROVED: 'Credencial aprobada', REJECTED: 'Credencial rechazada' };

export default function StudentCredential({ userId, verified, initial, onSent, onApproved }: {
  userId: string; verified: boolean; initial?: Photos; onSent: () => void; onApproved: () => void;
}) {
  const online = useOnline();
  const [photos, setPhotos] = useState(initial ?? emptyPhotos);
  const [row, setRow] = useState<StateRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const submitted = useRef(false);
  const reload = useCallback(async () => {
    if (!navigator.onLine) return;
    const { data, error } = await supabase.from('student_credential_requests').select('status,reason')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error && !navigator.onLine) return;
    if (error) { setMessage('No se pudo consultar tu credencial.'); setLoaded(false); return; }
    setRow(data as StateRow | null);
    setLoaded(true);
    if (data?.status === 'APPROVED' && !verified) onApproved();
  }, [userId, verified, onApproved]);
  useEffect(() => { if (online) void reload(); }, [online, reload]);

  const submit = useCallback(async (selected: Photos) => {
    if (!navigator.onLine || !selected.front || !selected.back || !selected.consent || submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setMessage('');
    try {
      const form = new FormData();
      form.set('front', await preparePhoto(selected.front), 'front.jpg');
      form.set('back', await preparePhoto(selected.back), 'back.jpg');
      form.set('consent', 'yes');
      if (!navigator.onLine) return;
      const { data, error } = await supabase.functions.invoke('analizar-credencial', { body: form });
      if (error) throw Error('No se pudo confirmar el envío. Revisa el estado antes de reintentar.');
      setMessage(data?.message || 'Solicitud recibida.');
      setPhotos(emptyPhotos);
      onSent();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo enviar la credencial.');
    } finally {
      await reload();
      submitted.current = false;
      setBusy(false);
    }
  }, [onSent, reload]);
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!online) {
      autoStarted.current = true;
      return;
    }
    if (loaded && !verified && !row && initial && !autoStarted.current) {
      autoStarted.current = true;
      void submit(initial);
    }
  }, [online, loaded, verified, row, initial, submit]);

  return <section className="card-surface page-wrap" aria-label="Credencial de estudiante">
    <h2>Mi credencial</h2>
    {!online && !verified && (!row || row.status === 'REJECTED') && <p role="status">{offlineNotice}</p>}
    <p role="status">{busy ? 'Enviando la credencial…' : message}</p>
    {row && <p><strong>{labels[row.status]}</strong>{row.reason && ' · ' + row.reason}</p>}
    {verified && !row && <p>Estudiante verificado</p>}
    {loaded && !verified && (!row || row.status === 'REJECTED') && <form onSubmit={event => {
      event.preventDefault(); void submit(photos);
    }}>
      <fieldset disabled={busy}>
        <CredentialFields value={photos} onChange={setPhotos} />
        <button className="primary-button" disabled={!online || !photos.front || !photos.back || !photos.consent}>
          {row ? 'Reenviar credencial' : 'Enviar credencial a revisión'}
        </button>
      </fieldset>
    </form>}
    <button className="secondary-button" disabled={busy || !online} onClick={() => { setMessage(''); void reload(); }}>Actualizar estado</button>
  </section>;
}
