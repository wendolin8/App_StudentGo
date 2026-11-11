import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import CompanionShareModal from '@/components/CompanionShareModal';
import { listCompanions, revokeCompanion, type CompanionRow } from '@/lib/companions';
import '@/styles/companions.css';

const RESPONSE_LABEL: Record<string, string> = {
  ARRIVED: 'Confirmó que llegaste',
  NOT_ARRIVED: 'Reportó que no has llegado',
  CANNOT_CONFIRM: 'No pudo confirmar',
};

function statusOf(row: CompanionRow): { text: string; tone: 'confirmed' | 'pending' | 'rejected' } {
  if (row.revoked_at) return { text: 'Revocado', tone: 'rejected' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { text: 'Expirado', tone: 'rejected' };
  if (row.arrival_response) return { text: RESPONSE_LABEL[row.arrival_response] ?? 'Respondió', tone: row.arrival_response === 'ARRIVED' ? 'confirmed' : 'pending' };
  return { text: 'Pendiente de confirmar', tone: 'pending' };
}

function deliveryOf(status: string): string {
  if (status === 'DELIVERED') return 'WhatsApp entregado';
  if (status === 'ACCEPTED') return 'WhatsApp aceptado por Meta; entrega pendiente';
  if (status === 'FAILED') return 'WhatsApp falló; revisa el estado';
  if (status === 'CANCELLED') return 'No enviado: se revocó el consentimiento';
  if (status === 'REQUESTED') return 'Solicitud WhatsApp pendiente de envío';
  return 'Sin estado de entrega WhatsApp';
}

export default function CompanionPanel({ tripId, tripRequestId, userId, tripLabel, autoPrompt = false }: { tripId: string; tripRequestId: string; userId: string; tripLabel: string; autoPrompt?: boolean }) {
  const [rows, setRows] = useState<CompanionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [message, setMessage] = useState('');
  const [locationMessage, setLocationMessage] = useState('');
  const [preferenceKnown, setPreferenceKnown] = useState(false);
  const [activePreference, setActivePreference] = useState(false);

  const load = useCallback(async () => {
    const data = await listCompanions(tripRequestId);
    setFailed(data === null);
    setRows(data);
  }, [tripRequestId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let active = true;
    void supabase.from('trip_companionship_preferences').select('active').eq('trip_id', tripId).eq('user_id', userId).maybeSingle().then(({ data }) => {
      if (!active) return;
      setActivePreference(data?.active === true);
      setPreferenceKnown(true);
      const promptKey = `studentgo-companion-prompt:${tripId}:${userId}`;
      if (!data && autoPrompt && window.sessionStorage.getItem(promptKey) !== 'seen') {
        window.sessionStorage.setItem(promptKey, 'seen');
        setShowModal(true);
      }
    });
    return () => { active = false; };
  }, [tripId, userId, autoPrompt]);

  const activeCount = rows?.filter((row) => !row.revoked_at && !row.closed_at && new Date(row.expires_at).getTime() > Date.now()).length ?? 0;

  useEffect(() => {
    if (activeCount === 0) { setLocationMessage(''); return; }
    if (!navigator.geolocation) { setLocationMessage('Este dispositivo no permite compartir ubicación.'); return; }
    let lastSentAt = 0;
    let sending = false;
    setLocationMessage('Permite el acceso a la ubicación para compartir actualizaciones durante el viaje.');
    const watchId = navigator.geolocation.watchPosition(async (position) => {
      const now = Date.now();
      if (sending || now - lastSentAt < 15000) return;
      sending = true;
      const { data, error } = await supabase.rpc('record_companion_location', {
        p_trip_request_id: tripRequestId,
        p_latitude: position.coords.latitude,
        p_longitude: position.coords.longitude,
      });
      sending = false;
      if (!error && data === true) { lastSentAt = now; setLocationMessage(`Ubicación compartida · ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}`); }
      else if (error) setLocationMessage('No pudimos actualizar la ubicación. Revisa tu conexión.');
    }, () => setLocationMessage('No hay permiso de ubicación. Puedes activarlo en los permisos del navegador.'), { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [activeCount, tripRequestId]);

  async function revoke(id: string) {
    const ok = await revokeCompanion(id);
    setMessage(ok ? 'Enlace revocado. Ya no podrá ver tu ubicación.' : 'No pudimos revocar el enlace. Intenta de nuevo.');
    if (ok) void load();
  }

  return <div className="companion-panel">
    <div className="trip-meta">
      <span><ShieldCheck size={14} /> Acompañamiento del pasajero · {activeCount} de 3 personas con acceso</span>
      <button className="small-button" disabled={activeCount >= 3} onClick={() => setShowModal(true)}><UserPlus size={14} /> {activePreference ? 'Gestionar acompañamiento' : 'Configurar acompañamiento'}</button>
    </div>
    {preferenceKnown && !activePreference && <div className="scanner-status">Tu QR confirmó el abordaje. Puedes compartir tu recorrido cuando quieras; el QR y el SOS no dan consentimiento por ti.</div>}
    {activeCount > 0 && <p className="scanner-status">{locationMessage}</p>}
    {failed && <div className="auth-error">No pudimos cargar tus acompañantes.</div>}
    {rows?.map((row) => {
      const status = statusOf(row);
      const active = status.tone !== 'rejected' && !row.closed_at;
      return <div className="contact-item" key={row.id}>
        <div><strong>{row.name}</strong><span>{row.relationship} · {row.source === 'EMERGENCY_CONTACT' ? 'Contacto de emergencia' : 'Persona que espera'}</span><span>{deliveryOf(row.delivery_status)}</span></div>
        <div className="trip-meta"><span className={`status-pill ${status.tone}`}>{status.text}</span>{active && <button className="small-button" onClick={() => { void revoke(row.id); }}><Trash2 size={14} /> Revocar</button>}</div>
      </div>;
    })}
    {message && <p className="scanner-status">{message}</p>}
    {showModal && <CompanionShareModal tripId={tripId} tripRequestId={tripRequestId} userId={userId} tripLabel={tripLabel} activeCount={activeCount} onClose={() => setShowModal(false)} onCreated={() => {
      void load();
      void supabase.from('trip_companionship_preferences').select('active').eq('trip_id', tripId).eq('user_id', userId).maybeSingle().then(({ data }) => setActivePreference(data?.active === true));
    }} />}
  </div>;
}
