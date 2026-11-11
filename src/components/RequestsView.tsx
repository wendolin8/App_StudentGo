import { useEffect, useState } from 'react';
import { Camera, Car, Check, Clock3, Compass, MapPin, Plus, QrCode, ShieldCheck, UsersRound } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useRides } from '@/lib/useRides';
import { REQUEST_LABEL, REQUEST_PILL, canOfferPassengerCompanionship, formatRideDate, isFinishedTrip, type DriverTripGroup, type PassengerRide, type RideTripStatus, type DriverRequest } from '@/lib/rides';
import QrPassengerCard from '@/components/QrPassengerCard';
import QrScannerModal from '@/components/QrScannerModal';
import CompanionPanel from '@/components/CompanionPanel';

const TRIP_LABEL: Record<RideTripStatus, string> = { PUBLISHED: 'Publicado', FULL: 'Completo', IN_PROGRESS: 'En curso', COMPLETED: 'Completado', CANCELLED: 'Cancelado' };

type RpcResult = { ok: boolean; reason: string };

export default function RequestsView({ userId, isDriver, canPublish, onPublish, onOpenSafety }: { userId: string; isDriver: boolean; canPublish: boolean; onPublish: () => void; onOpenSafety: () => void }) {
  const { rides, groups, loading, failed, errorMessage, reload } = useRides(userId, isDriver);
  const [tab, setTab] = useState<'passenger' | 'driver'>(isDriver ? 'driver' : 'passenger');
  useEffect(() => { setTab(isDriver ? 'driver' : 'passenger'); }, [isDriver]);
  const activeRides = rides.filter((ride) => !isFinishedTrip(ride.trip.status));
  const activeGroups = groups.filter((group) => !isFinishedTrip(group.trip.status));

  return <div className="page-wrap">
    <div className="page-title"><div><p className="eyebrow">TU ACTIVIDAD</p><h1>Solicitudes</h1><p>Gestiona tus solicitudes activas como pasajero y como conductor.</p></div></div>
    {isDriver && <div className="segmented">
      <button className={tab === 'passenger' ? 'selected' : ''} onClick={() => setTab('passenger')}>Como pasajero <span>{activeRides.length}</span></button>
      <button className={tab === 'driver' ? 'selected' : ''} onClick={() => setTab('driver')}>Como conductor <span>{activeGroups.length}</span></button>
    </div>}
    {failed && <div className="sos-status">{errorMessage || 'No pudimos cargar tus solicitudes.'} <button className="small-button" onClick={() => { void reload(); }}>Reintentar</button></div>}
    {!failed && loading && <p className="scanner-status">Cargando solicitudes...</p>}
    {!failed && !loading && tab === 'passenger' && <PassengerRequests rides={activeRides} userId={userId} onOpenSafety={onOpenSafety} />}
    {!failed && !loading && tab === 'driver' && isDriver && <>
      {canPublish && <div className="trip-meta" style={{ marginBottom: 16 }}><button className="primary-button" onClick={onPublish}><Plus size={16} /> Publicar viaje</button></div>}
      <DriverRequests groups={activeGroups} onChanged={() => { void reload(); }} onOpenSafety={onOpenSafety} />
    </>}
  </div>;
}

function PassengerRequests({ rides, userId, onOpenSafety }: { rides: PassengerRide[]; userId: string; onOpenSafety: () => void }) {
  const [openQrId, setOpenQrId] = useState<string | null>(null);
  if (!rides.length) return <div className="empty-panel"><div className="empty-icon"><Compass size={25} /></div><h3>No tienes solicitudes activas</h3><p>Busca un viaje en Inicio para solicitar un lugar.</p></div>;
  return <div className="trip-list">{rides.map(({ request, trip }) => {
    const started = trip.status === 'IN_PROGRESS';
    const boarded = canOfferPassengerCompanionship(request);
    const accepted = request.status === 'ACCEPTED';
    const stateText = !accepted ? (request.status === 'PENDING' ? 'Esperando respuesta del conductor.' : 'Esta solicitud ya no está activa.')
      : boarded ? 'Tu abordaje fue validado. Puedes configurar tu Acompañamiento Inteligente.'
        : started ? 'Viaje en curso.' : trip.meetingPointReachedAt ? 'El conductor llegó al punto de encuentro.' : 'Por salir.';
    return <article className="trip-card" key={request.id}>
      <div className="trip-main"><div className="avatar trip-avatar" style={{ background: '#d9e6ff' }}><Car size={18} /></div><div className="trip-copy"><strong>Conductor verificado</strong><span>{trip.vehicle || 'Vehículo no disponible'}</span></div><div className="trip-price"><strong>${request.fare}</strong><span>MXN</span></div></div>
      <div className="trip-route"><div><span className="route-dot purple" />{trip.origin}</div><div className="route-connector" /><div><span className="route-dot dark" />{trip.destination}</div></div>
      <div className="trip-meta"><span><Clock3 size={14} /> {formatRideDate(trip.departureAt)}</span><span className={`status-pill ${REQUEST_PILL[request.status]}`}>{REQUEST_LABEL[request.status]}</span></div>
      <p className="scanner-status">{stateText}</p>
      {accepted && <div className="trip-meta">
        <button className="small-button" onClick={() => setOpenQrId(openQrId === request.id ? null : request.id)}><QrCode size={14} /> {openQrId === request.id ? 'Ocultar QR' : 'Ver QR de abordaje'}</button>
        {boarded && <button className="small-button" onClick={onOpenSafety}>Centro de seguridad</button>}
      </div>}
      {accepted && openQrId === request.id && <QrPassengerCard tripId={trip.id} started={started} />}
      {accepted && boarded && <CompanionPanel tripId={trip.id} tripRequestId={request.id} userId={userId} tripLabel={`${trip.origin} → ${trip.destination}`} autoPrompt />}
    </article>;
  })}</div>;
}

function DriverRequests({ groups, onChanged, onOpenSafety }: { groups: DriverTripGroup[]; onChanged: () => void; onOpenSafety: () => void }) {
  const [message, setMessage] = useState('');
  const [showScanner, setShowScanner] = useState(false);

  async function runRpc(name: 'accept_ride_request' | 'reject_ride_request', requestId: string, pending: string) {
    setMessage(pending);
    const { data, error } = await supabase.rpc(name, { request_id: requestId });
    const result = (data as RpcResult[] | null)?.[0];
    if (error || !result) { setMessage('No pudimos completar la acción. Intenta de nuevo.'); return; }
    if (result.ok) { setMessage(name === 'accept_ride_request' ? 'Solicitud aceptada. El pasajero recibió su QR de abordaje.' : 'Solicitud rechazada.'); onChanged(); }
    else setMessage('No se pudo completar: ' + result.reason);
  }

  async function runTripRpc(name: 'mark_meeting_point_reached' | 'complete_ride', tripId: string, pending: string, success: string) {
    setMessage(pending);
    const { data, error } = await supabase.rpc(name, { trip_uuid: tripId });
    const result = (data as RpcResult[] | null)?.[0];
    if (error || !result) { setMessage('No pudimos completar la acción. Intenta de nuevo.'); return; }
    if (result.ok) { setMessage(success); onChanged(); }
    else setMessage('No se pudo completar: ' + result.reason);
  }

  return <>
    <div className="section-header"><div><p className="eyebrow">SOLICITUDES DE PASAJEROS</p><h2>Tus viajes publicados</h2></div><button className="primary-button" onClick={() => setShowScanner(true)}><Camera size={17} /> Escanear QR</button></div>
    {message && <div className="sos-status"><Check size={18} /> {message}</div>}
    {!groups.length && <div className="empty-panel"><div className="empty-icon"><UsersRound size={25} /></div><h3>No tienes viajes activos</h3><p>Cuando publiques un viaje, las solicitudes aparecerán aquí.</p></div>}
    {groups.map(({ trip, requests }) => {
      const pending = requests.filter((r) => r.status === 'PENDING');
      const accepted = requests.filter((r) => r.status === 'ACCEPTED');
      const started = trip.status === 'IN_PROGRESS';
      const open = trip.status === 'PUBLISHED' || trip.status === 'FULL';
      return <article className="trip-card" key={trip.id} style={{ marginBottom: 16 }}>
        <div className="trip-main"><div className="avatar trip-avatar" style={{ background: '#d9e6ff' }}><MapPin size={18} /></div><div className="trip-copy"><strong>{trip.origin} → {trip.destination}</strong><span>{formatRideDate(trip.departureAt)} · {trip.vehicle || 'Vehículo'}</span></div><div className="trip-price"><strong>${trip.suggestedFare}</strong><span>MXN</span></div></div>
        <div className="trip-meta"><span className={`status-pill ${started ? 'pending' : 'confirmed'}`}>{TRIP_LABEL[trip.status]}</span><span><UsersRound size={14} /> {accepted.length} confirmados</span></div>
        {pending.map((req) => <RequestRow key={req.id} req={req} actionable={open} onAccept={() => { void runRpc('accept_ride_request', req.id, 'Aceptando solicitud...'); }} onReject={() => { void runRpc('reject_ride_request', req.id, 'Rechazando solicitud...'); }} />)}
        {accepted.map((req) => <RequestRow key={req.id} req={req} actionable={false} />)}
        {accepted.length > 0 && open && !trip.meetingPointReachedAt && <button className="primary-button wide" style={{ marginTop: 12 }} onClick={() => { void runTripRpc('mark_meeting_point_reached', trip.id, 'Registrando tu llegada al punto de encuentro...', 'Llegada registrada. Los pasajeros fueron avisados.'); }}><MapPin size={17} /> Llegué al punto de encuentro</button>}
        {open && accepted.length > 0 && <p className="scanner-status">Escanea el QR de cada pasajero al abordar para iniciar el recorrido.</p>}
        {started && <div className="trip-meta" style={{ marginTop: 12 }}>
          <button className="primary-button" onClick={() => { void runTripRpc('complete_ride', trip.id, 'Finalizando viaje...', 'Viaje finalizado. Gracias por compartir tu camino.'); }}><Check size={16} /> Finalizar viaje</button>
          <button className="small-button" onClick={onOpenSafety}><ShieldCheck size={14} /> Seguridad y SOS del viaje</button>
        </div>}
      </article>;
    })}
    {showScanner && <QrScannerModal onClose={() => { setShowScanner(false); onChanged(); }} />}
  </>;
}

function RequestRow({ req, actionable, onAccept, onReject }: { req: DriverRequest; actionable: boolean; onAccept?: () => void; onReject?: () => void }) {
  const label = req.status === 'PENDING' ? 'Pendiente' : req.tripStartedAt ? 'En viaje' : req.passengerConfirmedAt ? 'Llegó bien' : 'Aceptado';
  return <div className="contact-item" style={{ marginTop: 10 }}>
    <div><strong>{req.passengerName}</strong><span>${req.fare} MXN</span></div>
    {req.status === 'PENDING' && actionable ? <div><button className="small-button" onClick={onAccept}>Aceptar</button><button className="small-button" style={{ background: '#dc2626' }} onClick={onReject}>Rechazar</button></div>
      : <span className={`status-pill ${req.status === 'PENDING' ? 'pending' : 'confirmed'}`}>{label}</span>}
  </div>;
}
