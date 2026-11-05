import { useEffect, useState } from 'react';
import { MapPin, ShieldCheck, Siren, X, PhoneCall, Check } from 'lucide-react';
import { supabase } from '@/lib/supabase';

type SosDetailAlert = { id: string; role: string; status: string; message: string | null; created_at: string; resolved_at: string | null; latitude: number | null; longitude: number | null; resolution_note: string | null };
type CompanionContext = { companion_id: string; name: string; relationship: string; source: string; delivery_status: string; arrival_response: string | null; arrival_responded_at: string | null; expires_at: string; revoked_at: string | null; created_at: string };
type WhatsAppLog = { id: string; purpose: string; recipient_phone: string; status: string; provider_status: string | null; failure_detail: string | null; requested_at: string; accepted_at: string | null; delivered_at: string | null; failed_at: string | null };

const SOURCE_LABEL: Record<string, string> = { EMERGENCY_CONTACT: 'Contacto de emergencia', COMPANION: 'Persona que espera' };
const RESPONSE_LABEL: Record<string, string> = { ARRIVED: 'Confirmó que llegaste', NOT_ARRIVED: 'Reportó que no has llegado', CANNOT_CONFIRM: 'No pudo confirmar' };

export default function SosIncidentDetail({ alert, onClose }: { alert: SosDetailAlert; onClose: () => void }) {
  const [companions, setCompanions] = useState<CompanionContext[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [whatsappLogs, setWhatsappLogs] = useState<WhatsAppLog[]>([]);
  const [whatsappLoadFailed, setWhatsappLoadFailed] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifiedBy, setVerifiedBy] = useState('');
  const [method, setMethod] = useState('CONFIRMO_EN_APP');
  const [note, setNote] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.rpc('get_sos_incident_context', { alert_uuid: alert.id }),
      supabase.from('whatsapp_messages').select('id, purpose, recipient_phone, status, provider_status, failure_detail, requested_at, accepted_at, delivered_at, failed_at').eq('sos_alert_id', alert.id).order('requested_at'),
    ]).then(([{ data, error }, { data: waData, error: waError }]) => {
      if (!active) return;
      if (error || !Array.isArray(data)) { setFailed(true); setCompanions([]); return; }
      setFailed(false);
      setCompanions(data as CompanionContext[]);
      setWhatsappLogs((waData ?? []) as WhatsAppLog[]);
      setWhatsappLoadFailed(!!waError);
    });
    return () => { active = false; };
  }, [alert.id]);

  async function startVerification(): Promise<void> {
    setBusy(true); setActionMessage('');
    const { data, error } = await supabase.rpc('start_sos_verification', { alert_uuid: alert.id });
    setBusy(false);
    if (error || !data?.[0]?.ok) { setActionMessage('No se pudo iniciar la verificación del incidente.'); return; }
    setActionMessage('Incidente en verificación.');
    window.location.reload();
  }

  async function resolveIncident(): Promise<void> {
    setBusy(true); setActionMessage('');
    const { data, error } = await supabase.rpc('resolve_sos', { alert_uuid: alert.id, p_verified_by: verifiedBy.trim(), p_method: method, p_note: note.trim() });
    setBusy(false);
    if (error || !data?.[0]?.ok) { setActionMessage('No se pudo resolver. Registra quién confirmó y una nota de al menos 10 caracteres.'); return; }
    setActionMessage('Incidente resuelto con verificación registrada.');
    window.location.reload();
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card" onMouseDown={(event) => event.stopPropagation()}>
    <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
    <p className="eyebrow center">INCIDENTE SOS</p>
    <h2><Siren size={18} /> {alert.status === 'RESOLVED' ? 'Incidente resuelto' : 'Atención requerida'}</h2>
    <p className="modal-lead">{alert.message || 'Sin mensaje adicional'}</p>
    <a className="small-button" href="tel:911"><PhoneCall size={14} /> Llamar al 911</a>
    {alert.status === 'ACTIVE' && <button className="primary-button" disabled={busy} onClick={() => { void startVerification(); }}><ShieldCheck size={15} /> Iniciar verificación</button>}
    {alert.status === 'VERIFYING' && <section className="admin-panel">
      <h3>Registrar resolución</h3>
      <input value={verifiedBy} onChange={(event) => setVerifiedBy(event.target.value)} placeholder="Quién confirmó" />
      <select value={method} onChange={(event) => setMethod(event.target.value)}>
        <option value="CONFIRMO_EN_APP">Confirmación en la app</option><option value="VERIFICO_LLAMADA">Verificado por llamada</option><option value="REPORTE_911">Reporte 911 confirmado</option><option value="FALSA_ALARMA">Falsa alarma verificada</option>
      </select>
      <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Evidencia de la verificación (mínimo 10 caracteres)" />
      <button className="primary-button" disabled={busy || verifiedBy.trim().length < 3 || note.trim().length < 10} onClick={() => { void resolveIncident(); }}><Check size={15} /> Resolver incidente</button>
    </section>}
    {actionMessage && <p className="scanner-status">{actionMessage}</p>}
    <div className="contact-item"><div><strong>Reportado por</strong><span>{alert.role === 'DRIVER' ? 'Conductor' : 'Pasajero'} · {new Date(alert.created_at).toLocaleString('es-MX')}</span>{alert.resolved_at && <span>Resuelto {new Date(alert.resolved_at).toLocaleString('es-MX')}</span>}{alert.resolution_note && <span>Nota: {alert.resolution_note}</span>}</div></div>
    {alert.latitude != null && alert.longitude != null && <a className="small-button" href={`https://www.google.com/maps?q=${alert.latitude},${alert.longitude}`} target="_blank" rel="noreferrer"><MapPin size={14} /> Ver ubicación</a>}

    <h3><ShieldCheck size={16} /> Acompañantes vinculados</h3>
    {companions === null && <p className="scanner-status">Cargando acompañantes...</p>}
    {failed && <div className="auth-error">No pudimos cargar los acompañantes de este incidente.</div>}
    {companions?.length === 0 && !failed && <p className="scanner-status">Este incidente no tiene acompañantes vinculados.</p>}
    {companions?.map((companion) => <div className="contact-item" key={companion.companion_id}><div><strong>{companion.name}</strong><span>{companion.relationship} · {SOURCE_LABEL[companion.source] ?? companion.source}</span><span>{companion.arrival_response ? RESPONSE_LABEL[companion.arrival_response] ?? companion.arrival_response : 'Sin respuesta de llegada'}</span>{companion.arrival_responded_at && <span>{new Date(companion.arrival_responded_at).toLocaleString('es-MX')}</span>}</div></div>)}
    <h3>Estado de avisos por WhatsApp</h3>
    {whatsappLoadFailed && <p className="auth-error">No se pudo consultar el registro de WhatsApp.</p>}
    {!whatsappLoadFailed && whatsappLogs.length === 0 && <p className="scanner-status">No hay un mensaje externo autorizado para este incidente. No se reporta ningún envío.</p>}
    {whatsappLogs.map((item) => <div className="contact-item" key={item.id}><div><strong>{item.status}{item.provider_status ? ` · Meta: ${item.provider_status}` : ''}</strong><span>{item.purpose} · celular terminado en {item.recipient_phone.slice(-4)}</span><span>Solicitado: {new Date(item.requested_at).toLocaleString('es-MX')}{item.accepted_at ? ` · Aceptado: ${new Date(item.accepted_at).toLocaleString('es-MX')}` : ''}{item.delivered_at ? ` · Entregado: ${new Date(item.delivered_at).toLocaleString('es-MX')}` : ''}{item.failed_at ? ` · Falló: ${new Date(item.failed_at).toLocaleString('es-MX')}` : ''}</span>{item.failure_detail && <span>{item.failure_detail}</span>}</div></div>)}
  </div></div>;
}
