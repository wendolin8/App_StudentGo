import { useState } from 'react';
import { Car, Clock3, History, MapPin, UsersRound } from 'lucide-react';
import { useRides } from '@/lib/useRides';
import { driverOutcome, formatRideDate, isFinishedTrip, passengerOutcome, type DriverTripGroup, type PassengerRide } from '@/lib/rides';

export default function HistoryView({ userId, isDriver }: { userId: string; isDriver: boolean }) {
  const { rides, groups, loading, failed, reload } = useRides(userId, isDriver);
  const [tab, setTab] = useState<'passenger' | 'driver'>('passenger');
  const finishedRides = rides.filter((ride) => isFinishedTrip(ride.trip.status)).sort((a, b) => b.trip.departureAt.localeCompare(a.trip.departureAt));
  const finishedGroups = groups.filter((group) => isFinishedTrip(group.trip.status));

  return <div className="page-wrap">
    <div className="page-title"><div><p className="eyebrow">TU ACTIVIDAD</p><h1>Historial</h1><p>Viajes finalizados o cancelados.</p></div></div>
    {isDriver && <div className="segmented">
      <button className={tab === 'passenger' ? 'selected' : ''} onClick={() => setTab('passenger')}>Como pasajero <span>{finishedRides.length}</span></button>
      <button className={tab === 'driver' ? 'selected' : ''} onClick={() => setTab('driver')}>Como conductor <span>{finishedGroups.length}</span></button>
    </div>}
    {failed && <div className="sos-status">No pudimos cargar tu historial. <button className="small-button" onClick={() => { void reload(); }}>Reintentar</button></div>}
    {!failed && loading && <p className="scanner-status">Cargando historial...</p>}
    {!failed && !loading && tab === 'passenger' && <PassengerHistory rides={finishedRides} />}
    {!failed && !loading && tab === 'driver' && isDriver && <DriverHistory groups={finishedGroups} />}
  </div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty-panel"><div className="empty-icon"><History size={25} /></div><h3>Sin viajes en el historial</h3><p>{text}</p></div>;
}

function PassengerHistory({ rides }: { rides: PassengerRide[] }) {
  if (!rides.length) return <Empty text="Aquí aparecerán tus viajes completados o cancelados." />;
  return <div className="trip-list">{rides.map(({ request, trip }) => {
    const outcome = passengerOutcome({ request, trip });
    return <article className="trip-card" key={request.id}>
      <div className="trip-main"><div className="avatar trip-avatar" style={{ background: '#d9e6ff' }}><Car size={18} /></div><div className="trip-copy"><strong>Conductor verificado</strong><span>{trip.vehicle || 'Vehículo no disponible'}</span></div><div className="trip-price"><strong>${request.fare}</strong><span>MXN</span></div></div>
      <div className="trip-route"><div><span className="route-dot purple" />{trip.origin}</div><div className="route-connector" /><div><span className="route-dot dark" />{trip.destination}</div></div>
      <div className="trip-meta"><span><Clock3 size={14} /> {formatRideDate(trip.departureAt)}</span><span className={`status-pill ${outcome.pill}`}>{outcome.label}</span></div>
    </article>;
  })}</div>;
}

function DriverHistory({ groups }: { groups: DriverTripGroup[] }) {
  if (!groups.length) return <Empty text="Aquí aparecerán los viajes que publicaste y finalizaron o se cancelaron." />;
  return <div className="trip-list">{groups.map(({ trip, requests }) => {
    const passengers = requests.filter((r) => r.status === 'ACCEPTED');
    const total = passengers.reduce((sum, r) => sum + r.fare, 0);
    const outcome = driverOutcome(trip);
    return <article className="trip-card" key={trip.id}>
      <div className="trip-main"><div className="avatar trip-avatar" style={{ background: '#d9e6ff' }}><MapPin size={18} /></div><div className="trip-copy"><strong>{trip.origin} → {trip.destination}</strong><span>{trip.vehicle || 'Vehículo no disponible'}{trip.plates ? ` · ${trip.plates}` : ''}</span></div><div className="trip-price"><strong>${total}</strong><span>MXN total</span></div></div>
      <div className="trip-meta"><span><Clock3 size={14} /> {formatRideDate(trip.departureAt)}</span><span><UsersRound size={14} /> {passengers.length} pasajeros · ${trip.suggestedFare} MXN c/u</span><span className={`status-pill ${outcome.pill}`}>{outcome.label}</span></div>
    </article>;
  })}</div>;
}
