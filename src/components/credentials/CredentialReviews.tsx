import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { scanQrFromImage } from '@/lib/qr';

type Reading = { nombre: string | null; matricula: string | null; institucion: string | null; vigencia: string | null };
type RequestRow = {
  id: string; user_id: string; registered_name: string; registered_number: string; reading: Reading | null; analysis_status: string;
};
type Evidence = { url: string; qr: string };
const normalizeName = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .trim().replace(/\s+/g, ' ').toUpperCase();
function comparison(registered: string, read: string | null, isName = false) {
  if (!read) return 'Sin lectura';
  const clean = isName ? normalizeName : (value: string) => value.trim().toUpperCase();
  return clean(registered) === clean(read) ? 'Coincide' : 'Revisar diferencia';
}

function Review({ row, onReviewed }: { row: RequestRow; onReviewed: () => void }) {
  const [files, setFiles] = useState<Evidence[]>([]);
  const [message, setMessage] = useState('Cargando documentos…');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    async function load() {
      const images: Evidence[] = [];
      for (const side of ['front', 'back']) {
        const path = row.user_id + '/' + row.id + '/' + side + '.jpg';
        const { data, error } = await supabase.storage.from('student-credentials').download(path);
        if (error || !data) throw Error('No se pudo abrir la evidencia. Cierra y vuelve a abrir la solicitud.');
        if (!active) return;
        const url = URL.createObjectURL(data);
        urls.push(url);
        let qr = 'Sin QR legible';
        try {
          const decoded = await scanQrFromImage(data, 1600);
          if (decoded) {
            qr = decoded.trim() === row.registered_number ? 'La matrícula del QR coincide con el registro.' :
              'Contenido leído (sin validar con la universidad): ' + decoded.slice(0, 500);
          }
        } catch { qr = 'No se pudo analizar el QR.'; }
        images.push({ url, qr });
      }
      if (active) { setFiles(images); setMessage(''); }
    }
    void load().catch(() => { if (active) setMessage('No se pudo abrir la evidencia. Cierra y vuelve a abrir la solicitud.'); });
    return () => { active = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [row.id, row.user_id, row.registered_number]);
  async function decide(approve: boolean) {
    setBusy(true);
    const { error } = await supabase.rpc('review_student_credential', { p_id: row.id, p_approve: approve, p_reason: reason });
    if (error) { setMessage(error.message); setBusy(false); return; }
    onReviewed();
  }
  return <div className="card-surface">
    <p role="status">{message}</p>
    {files.map((file, i) => <figure key={file.url}>
      <img src={file.url} alt={i === 0 ? 'Frente de la credencial' : 'Reverso de la credencial'}
        style={{ maxWidth: '100%', maxHeight: 340 }} />
      <figcaption style={{ overflowWrap: 'anywhere' }}>{file.qr}</figcaption>
    </figure>)}
    <h3>Lectura de Gemini</h3>
    {row.reading ? <dl>
      <dt>Nombre leído</dt><dd>{row.reading.nombre || 'Ilegible'} · {comparison(row.registered_name, row.reading.nombre, true)}</dd>
      <dt>Matrícula leída</dt><dd>{row.reading.matricula || 'Ilegible'} · {comparison(row.registered_number, row.reading.matricula)}</dd>
      <dt>Institución</dt><dd>{row.reading.institucion || 'Ilegible'}</dd>
      <dt>Vigencia impresa</dt><dd>{row.reading.vigencia || 'Ilegible'}</dd>
    </dl> : <p>{row.analysis_status === 'UNAVAILABLE' ? 'Gemini no pudo leer esta credencial.' : 'Lectura aún no disponible.'} Puedes revisar las imágenes manualmente.</p>}
    <label>Motivo si rechazas la solicitud
      <textarea value={reason} maxLength={500} onChange={event => setReason(event.target.value)} />
    </label>
    <button className="primary-button" disabled={busy || files.length !== 2} onClick={() => void decide(true)}>Aprobar</button>
    <button className="secondary-button" disabled={busy || !reason.trim()} onClick={() => void decide(false)}>Rechazar</button>
  </div>;
}

export default function CredentialReviews({ onChange }: { onChange: () => void }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState('Consultando solicitudes…');
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('student_credential_requests')
      .select('id,user_id,registered_name,registered_number,reading,analysis_status').eq('status','PENDING').order('created_at');
    if (error) { setMessage('No se pudo consultar la lista.'); return; }
    setRows(data || []);
    setMessage(data?.length ? '' : 'No hay credenciales pendientes.');
  }, []);
  useEffect(() => { void load(); }, [load]);
  return <section className="admin-content">
    <button className="secondary-button" onClick={() => void load()}>Actualizar solicitudes</button>
    <p role="status">{message}</p>
    {rows.map(row => <article key={row.id} className="admin-panel">
      <h3>{row.registered_name}</h3><p>Matrícula del registro · {row.registered_number}</p>
      <button className="small-button" onClick={() => setSelected(selected === row.id ? null : row.id)}>
        {selected === row.id ? 'Cerrar' : 'Revisar credencial'}
      </button>
      {selected === row.id && <Review row={row} onReviewed={() => { setSelected(null); void load(); onChange(); }} />}
    </article>)}
  </section>;
}
