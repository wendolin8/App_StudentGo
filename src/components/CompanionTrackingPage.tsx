import { useEffect, useState } from 'react';
import { Check, Clock3, MapPin, ShieldCheck, TriangleAlert } from 'lucide-react';
import { fetchTracking, respondArrival, type ArrivalResponse, type TrackingResult } from '@/lib/companions';
import { supabase } from '@/lib/supabase';
import '@/styles/companions.css';

const RESPONSE_COPY: Record<ArrivalResponse, string> = {
  ARRIVED: 'Gracias. Registramos que llegó a salvo y el acompañamiento quedó finalizado.',
  NOT_ARRIVED: 'El reporte quedó registrado como incidente y se avisó internamente al administrador. Si hay peligro inmediato, llama al 911.',
  CANNOT_CONFIRM: 'Registramos que no pudiste confirmar por ahora. Puedes responder más tarde desde este enlace.',
};

export default function CompanionTrackingPage({ token }: { token: string }) {
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [answer, setAnswer] = useState<ArrivalResponse | null>(null);
  const [answerError, setAnswerError] = useState('');
  const [sending, setSending] = useState(false);
  const [whatsappMessage, setWhatsappMessage] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = () => { void fetchTracking(token).then((data) => {
      if (!active) return;
      if (data === null) setFailed(true);
      else { setFailed(false); setResult(data); }
      setLoading(false);
    }); };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);

  async function answerWith(response: ArrivalResponse) {
    setSending(true);
    setAnswerError('');
    const outcome = await respondArrival(token, response);
    setSending(false);
    if (outcome.ok) {
      setAnswer(response);
      if (response === 'NOT_ARRIVED' && outcome.sosAlertId) {
        const { data, error } = await supabase.functions.invoke('whatsapp-send', { body: { action: 'COMPANION_NO_ARRIVED', token } });
        setWhatsappMessage(error ? 'Student Go no pudo confirmar el resultado del envío por WhatsApp. El incidente sí quedó registrado.' : String(data?.message ?? 'No hay confirmación de entrega de WhatsApp.'));
      }
    }
    else setAnswerError(outcome.message);
  }

  return <div className="track-page">
    <header className="track-header"><div className="brand"><div className="brand-mark"><MapPin size={22} strokeWidth={2.5} /></div><div><strong>Estudiante <em>Ir</em></strong><span>Acompañamiento inteligente</span></div></div></header>
    <main className="track-body">
      {loading && <p className="scanner-status">Cargando acompañamiento...</p>}
      {!loading && failed && <div className="auth-error">No pudimos cargar el acompañamiento. Revisa tu conexión e intenta de nuevo.</div>}
      {!loading && !failed && result && !result.ok && <div className="empty-panel"><div className="empty-icon"><TriangleAlert size={25} /></div><h3>Este enlace ya no está disponible</h3><p>Pide a la persona que lo compartió que te envíe uno nuevo.</p></div>}
      {!loading && !failed && result?.ok && <>
        <section className="track-card card-surface">
          <p className="eyebrow">ESTADO DEL RECORRIDO</p>
          <h1>{result.view.studentFirstName} está en un viaje</h1>
          <p className="track-route"><MapPin size={16} /> {result.view.origin} → {result.view.destination}</p>
          <div className="trip-meta"><span><Clock3 size={14} /> {formatDate(result.view.departureAt)}</span><span className={`status-pill ${result.view.tripStarted ? 'pending' : 'confirmed'}`}>{result.view.tripCompleted ? 'Recorrido finalizado' : result.view.tripStarted ? 'En curso' : 'Por iniciar'}</span></div>
          {result.view.tripStarted && !result.view.tripCompleted && (result.view.latitude !== null && result.view.longitude !== null
            ? <p className="scanner-status">Última ubicación: {result.view.latitude.toFixed(5)}, {result.view.longitude.toFixed(5)} · actualizada {formatDate(result.view.locationAt ?? '')}</p>
            : <p className="scanner-status">Aún no hay una ubicación compartida.</p>)}
        </section>

        <section className="track-card card-surface">
          <p className="eyebrow">CONFIRMACIONES</p>
          <div className="contact-item"><div><strong>Llegada de {result.view.studentFirstName}</strong><span>{result.view.studentConfirmedAt ? `Confirmó el ${formatDate(result.view.studentConfirmedAt)}` : 'Pendiente de confirmación'}</span></div><span className={`status-pill ${result.view.studentConfirmedAt ? 'confirmed' : 'pending'}`}>{result.view.studentConfirmedAt ? 'Confirmada' : 'Pendiente'}</span></div>
          <div className="contact-item"><div><strong>Tu confirmación</strong><span>{result.view.companionResponse ? 'Respuesta registrada' : 'Pendiente'}</span></div><span className={`status-pill ${result.view.companionResponse === 'ARRIVED' ? 'confirmed' : 'pending'}`}>{result.view.companionResponse ? 'Registrada' : 'Pendiente'}</span></div>
        </section>

        {result.view.tripCompleted && !answer && !result.view.companionResponse && <section className="track-card card-surface">
          <p className="eyebrow">{result.view.companionName}, ¿puedes confirmar?</p>
          <h2>¿Puedes confirmar que llegó a salvo?</h2>
          <div className="track-answers">
            <button className="primary-button wide" disabled={sending} onClick={() => { void answerWith('ARRIVED'); }}><ShieldCheck size={17} /> SÍ, LLEGÓ</button>
            <button className="track-danger wide" disabled={sending} onClick={() => { void answerWith('NOT_ARRIVED'); }}><TriangleAlert size={17} /> NO HA LLEGADO</button>
            <button className="secondary-button wide" disabled={sending} onClick={() => { void answerWith('CANNOT_CONFIRM'); }}>NO PUEDO CONFIRMAR</button>
          </div>
          {answerError && <div className="auth-error">{answerError}</div>}
        </section>}

        {(answer || result.view.companionResponse) && <section className="track-card card-surface">
          <div className="request-confirmed"><Check size={20} /><div><strong>Respuesta registrada</strong><span>{RESPONSE_COPY[answer ?? result.view.companionResponse ?? 'CANNOT_CONFIRM']}</span></div></div>
          {whatsappMessage && <p className="scanner-status" role="status">{whatsappMessage}</p>}
        </section>}
      </>}
    </main>
  </div>;
}

function formatDate(iso: string): string {
  if (!iso) return 'sin registro';
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}
