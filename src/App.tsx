import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import {
  Bell, Car, Check, ChevronRight, Clock3, ClipboardCheck, History, Inbox,
  Crosshair, Eye, EyeOff, Home, LogOut, MapPin, Menu, MessageCircle,
  Navigation, Search, ShieldCheck, UserRound, UsersRound, X, Shield,
} from 'lucide-react';
import SafetyView from '@/components/SafetyView';
import NotificationsView from '@/components/NotificationsView';
import RequestsView from '@/components/RequestsView';
import HistoryView from '@/components/HistoryView';
import AdminDashboard from '@/components/AdminDashboard';
import CompanionTrackingPage from '@/components/CompanionTrackingPage';
import EmergencyContactsEditor from '@/components/EmergencyContactsEditor';
import PasskeySignIn from '@/components/PasskeySignIn';
import PasskeySettings from '@/components/PasskeySettings';
import PasskeyOnboarding from '@/components/PasskeyOnboarding';
import { type LatLng, type RouteInfo, createMap, addMarker, drawRoute, fitToRoute, searchPlace, getRoute, getCurrentPosition } from '@/lib/maps';

type Tab = 'home' | 'requests' | 'history' | 'safety' | 'alerts' | 'profile' | 'admin';
type TripStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED';
type DriverRegistrationDraft = { brand: string; model: string; year: number; color: string; plates: string; capacity: number; license: File | null; registrationCard: File | null; licenseExpiresAt: string; registrationExpiresAt: string };
type DriverApplicationStatus = { status: 'INCOMPLETE' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED'; submitted_at: string | null; rejection_reason: string | null };
type PublishDraft = { origin: LatLng | null; destination: LatLng | null; originLabel: string; destinationLabel: string; departureAt: string; availableSeats: number; fare: number };

type Trip = {
  id: string;
  driver_id: string;
  driver: string;
  initials: string;
  route: string;
  from: string;
  to: string;
  time: string;
  seats: number;
  price: number;
  car: string;
  color: string;
  distanceKm: number;
  durationMin: number;
  origin: LatLng | null;
  destination: LatLng | null;
};

type Profile = {
  id: string;
  full_name: string;
  student_number: string;
  career: string | null;
  email: string;
  role: string;
  student_verified: boolean;
};

const navItems: { id: Tab; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Inicio', icon: Home },
  { id: 'requests', label: 'Solicitudes', icon: Inbox },
  { id: 'history', label: 'Historial', icon: History },
  { id: 'safety', label: 'Seguridad', icon: Shield },
  { id: 'alerts', label: 'Avisos', icon: Bell },
  { id: 'profile', label: 'Perfil', icon: UserRound },
  { id: 'admin', label: 'Revisión', icon: ClipboardCheck },
];

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('home');
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [persistedTrips, setPersistedTrips] = useState<Trip[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [requestStatuses, setRequestStatuses] = useState<Record<string, TripStatus>>({});
  const [requestsRefreshVersion, setRequestsRefreshVersion] = useState(0);
  const [showDriverFlow, setShowDriverFlow] = useState(false);
  const [showPublishFlow, setShowPublishFlow] = useState(false);
  const [approvedVehicles, setApprovedVehicles] = useState<Array<{ id: string; label: string; capacity: number }>>([]);
  const [driverApplicationStatus, setDriverApplicationStatus] = useState<DriverApplicationStatus | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [searchFrom, setSearchFrom] = useState('');
  const [searchTo, setSearchTo] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const adminRedirected = useRef(false);

  const loadUnread = useCallback(async (userId: string) => {
    const { count } = await supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', userId).is('read_at', null);
    setUnreadCount(count ?? 0);
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadUnread(user.id);
    const timer = window.setInterval(() => { void loadUnread(user.id); }, 30000);
    return () => window.clearInterval(timer);
  }, [user, loadUnread]);

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase.from('profiles').select('id, full_name, student_number, career, email, role, student_verified').eq('id', userId).maybeSingle();
    if (data) setProfile(data as Profile);
  }, []);

  useEffect(() => {
    if (!profile) {
      adminRedirected.current = false;
      return;
    }
    if (profile.role === 'ADMIN' && !adminRedirected.current) {
      setActiveTab('admin');
      adminRedirected.current = true;
    } else if (profile.role !== 'ADMIN' && activeTab === 'admin') {
      setActiveTab('home');
    }
  }, [profile, activeTab]);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
      if (data.session?.user) void loadProfile(data.session.user.id);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setUser(session?.user ?? null);
      if (session?.user) void loadProfile(session.user.id);
      else setProfile(null);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, [loadProfile]);

  const loadTrips = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.from('trips').select('id, driver_id, origin_text, destination_text, departure_at, available_seats, suggested_fare, vehicle_name, distance_km, estimated_minutes, origin_lat, origin_lng, destination_lat, destination_lng').eq('status', 'PUBLISHED').neq('driver_id', user.id).order('departure_at');
    if (error) return;
    setPersistedTrips((data ?? []).map((trip) => ({
      id: String(trip.id), driver_id: String(trip.driver_id), driver: 'Conductor Student Go', initials: 'SG',
      route: `${trip.origin_text} → ${trip.destination_text}`, from: trip.origin_text, to: trip.destination_text,
      time: new Date(trip.departure_at).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' }),
      seats: trip.available_seats, price: Number(trip.suggested_fare), car: trip.vehicle_name, color: '#d9e6ff',
      distanceKm: Number(trip.distance_km ?? 0), durationMin: Number(trip.estimated_minutes ?? 0),
      origin: trip.origin_lat != null && trip.origin_lng != null ? { lat: trip.origin_lat, lng: trip.origin_lng } : null,
      destination: trip.destination_lat != null && trip.destination_lng != null ? { lat: trip.destination_lat, lng: trip.destination_lng } : null,
    })));
  }, [user]);

  useEffect(() => { if (user) void loadTrips(); }, [user, loadTrips]);

  const loadDriverData = useCallback(async () => {
    if (!user) return;
    const { data: application } = await supabase.from('driver_applications').select('status, submitted_at, rejection_reason').eq('user_id', user.id).maybeSingle();
    setDriverApplicationStatus(application ? { status: application.status as DriverApplicationStatus['status'], submitted_at: application.submitted_at, rejection_reason: application.rejection_reason } : null);
    const { data: vehicles } = await supabase.from('vehicles').select('id, brand, model, passenger_capacity').eq('owner_id', user.id).eq('status', 'APPROVED');
    setApprovedVehicles((vehicles ?? []).map((vehicle) => ({ id: String(vehicle.id), label: `${vehicle.brand} ${vehicle.model}`, capacity: vehicle.passenger_capacity })));
  }, [user]);

  useEffect(() => { void loadDriverData(); }, [loadDriverData]);
  useEffect(() => { if (showDriverFlow) void loadDriverData(); }, [showDriverFlow, loadDriverData]);

  const loadRequestStatuses = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase.from('trip_requests').select('trip_id, status').eq('passenger_id', user.id);
    if (data) {
      const map: Record<string, TripStatus> = {};
      data.forEach((row) => { map[String(row.trip_id)] = row.status as TripStatus; });
      setRequestStatuses(map);
    }
  }, [user]);

  useEffect(() => { if (user) void loadRequestStatuses(); }, [user, loadRequestStatuses]);

  const visibleTrips = useMemo(
    () => persistedTrips.filter((trip) => trip.from.toLowerCase().includes(searchFrom.toLowerCase()) && trip.to.toLowerCase().includes(searchTo.toLowerCase())),
    [persistedTrips, searchFrom, searchTo],
  );

  async function registerDriver(draft: DriverRegistrationDraft): Promise<void> {
    if (!user || !draft.license || !draft.registrationCard) return;
    const allowed = ['image/jpeg', 'image/png', 'application/pdf'];
    if (!allowed.includes(draft.license.type) || !allowed.includes(draft.registrationCard.type) || draft.license.size > 10 * 1024 * 1024 || draft.registrationCard.size > 10 * 1024 * 1024) { setAuthError('Cada documento debe ser JPG, PNG o PDF y pesar menos de 10 MB.'); return; }
    setAuthError('Enviando registro de conductor...');
    const folder = user.id;
    const licensePath = `${folder}/driver-license-${Date.now()}.${draft.license.name.split('.').pop() ?? 'file'}`;
    const cardPath = `${folder}/registration-card-${Date.now()}.${draft.registrationCard.name.split('.').pop() ?? 'file'}`;
    const [licenseUpload, cardUpload] = await Promise.all([
      supabase.storage.from('student-documents').upload(licensePath, draft.license, { contentType: draft.license.type, upsert: false }),
      supabase.storage.from('student-documents').upload(cardPath, draft.registrationCard, { contentType: draft.registrationCard.type, upsert: false }),
    ]);
    if (licenseUpload.error || cardUpload.error) { setAuthError('No pudimos guardar tus documentos. Intenta nuevamente.'); return; }
    const { data, error } = await supabase.rpc('submit_driver_application', { p_brand: draft.brand, p_model: draft.model, p_year: draft.year, p_color: draft.color, p_plates: draft.plates, p_capacity: draft.capacity, p_license_path: licensePath, p_registration_card_path: cardPath, p_license_expires_at: draft.licenseExpiresAt, p_registration_expires_at: draft.registrationExpiresAt });
    if (error || !data?.[0]?.ok) { setAuthError('No pudimos enviar el registro. Revisa los datos e inténtalo de nuevo.'); return; }
    setDriverApplicationStatus({ status: 'PENDING_REVIEW', submitted_at: new Date().toISOString(), rejection_reason: null }); setAuthError(''); await loadDriverData();
  }

  async function publishTrip(draft: PublishDraft, vehicleId: string, routeInfo: RouteInfo | null): Promise<void> {
    if (!user || !draft.origin || !draft.destination || !routeInfo) return;
    const { error } = await supabase.rpc('publish_trip_with_vehicle', { p_vehicle_id: vehicleId, p_origin_text: draft.originLabel, p_destination_text: draft.destinationLabel, p_origin_lat: draft.origin.lat, p_origin_lng: draft.origin.lng, p_destination_lat: draft.destination.lat, p_destination_lng: draft.destination.lng, p_departure_at: new Date(draft.departureAt).toISOString(), p_available_seats: draft.availableSeats, p_distance_km: routeInfo.distanceKm, p_estimated_minutes: Math.round(routeInfo.durationMin), p_suggested_fare: draft.fare, p_notes: null });
    if (error) { setAuthError('No pudimos publicar tu viaje. Verifica que tu vehículo siga aprobado.'); return; }
    // RequestsView owns the driver's published-trip query. Refresh that view
    // immediately after the RPC succeeds instead of making the driver reload
    // the browser or wait for its background synchronisation interval.
    await Promise.all([loadTrips(), loadRequestStatuses()]);
    setShowPublishFlow(false);
    setActiveTab('requests');
    setRequestsRefreshVersion((current) => current + 1);
  }

  async function requestTrip(tripId: string): Promise<void> {
    if (!user) return;
    const trip = persistedTrips.find((item) => item.id === tripId);
    if (!trip) return;
    const { error } = await supabase.from('trip_requests').insert({ trip_id: tripId, passenger_id: user.id, fare: trip.price });
    if (error) { setAuthError('No fue posible enviar la solicitud.'); return; }
    setRequestStatuses((current) => ({ ...current, [tripId]: 'PENDING' }));
    setSelectedTrip(null);
  }

  async function signOut(): Promise<void> {
    await supabase.auth.signOut();
    setProfile(null);
  }

  const trackingMatch = window.location.pathname.match(/^\/seguimiento\/([A-Za-z0-9_-]+)\/?$/);
  if (trackingMatch) return <CompanionTrackingPage token={trackingMatch[1]} />;
  if (authLoading) return <div className="auth-loading">Cargando StudentGo...</div>;
  if (!user) return <AuthScreen error={authError} onError={setAuthError} />;

  if (!profile) return <div className="auth-loading">Cargando perfil seguro...</div>;
  if (profile.role === 'ADMIN') return <><PasskeyOnboarding key={user.id} userId={user.id} /><AdminDashboard profile={{ id: profile.id, full_name: profile.full_name, email: profile.email }} onSignOut={() => { void signOut(); }} /></>;

  const initials = profile.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase() || 'AB';
  const visibleNavItems = navItems.filter((item) => item.id !== 'admin');
  const isApprovedDriver = profile.role === 'DRIVER' && driverApplicationStatus?.status === 'APPROVED' && approvedVehicles.length > 0;
  const openDriverAction = () => {
    if (isApprovedDriver) setShowPublishFlow(true);
    else setShowDriverFlow(true);
  };
  const driverPrompt = isApprovedDriver
    ? { title: 'Ofrecer viaje', detail: 'Publica tu siguiente recorrido.' }
    : driverApplicationStatus?.status === 'PENDING_REVIEW'
      ? { title: 'Solicitud en revisión', detail: 'Consulta el estado de tu registro.' }
      : { title: '¿Tienes auto?', detail: 'Conviértete en conductor' };

  return (
    <div className="app-shell">
      <PasskeyOnboarding key={user.id} userId={user.id} />
      <aside className="sidebar">
        <Brand />
        <div className="sidebar-profile">
          <div className="avatar avatar-large">{initials}</div>
          <div><strong>{profile?.full_name ?? 'Estudiante'}</strong><span>{profile?.student_verified ? 'Estudiante verificada' : 'Verificación pendiente'}</span></div>
          {profile?.student_verified && <ShieldCheck size={18} className="verified-icon" />}
        </div>
        <nav className="desktop-nav">
          {visibleNavItems.map((item) => <NavButton key={item.id} item={item} active={activeTab === item.id} onClick={setActiveTab} badge={item.id === 'alerts' ? unreadCount : 0} />)}
        </nav>
        <div className="sidebar-bottom">
          <button className="driver-prompt" onClick={openDriverAction}>
            <div className="driver-prompt-icon"><Car size={20} /></div>
            <div><strong>{driverPrompt.title}</strong><span>{driverPrompt.detail}</span></div>
            <ChevronRight size={17} />
          </button>
          <button className="support-link"><MessageCircle size={17} /> Ayuda y soporte</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setShowMenu(true)} aria-label="Abrir menú"><Menu size={22} /></button>
          <div className="breadcrumb"><span>StudentGo</span><ChevronRight size={15} /><strong>{navItems.find((item) => item.id === activeTab)?.label}</strong></div>
          <div className="top-actions">
            <button className="icon-button notification-button" onClick={() => setActiveTab('alerts')} aria-label="Notificaciones"><Bell size={19} /><i /></button>
            <div className="top-user"><div className="avatar">{initials}</div><span>{profile?.full_name?.split(' ')[0] ?? 'Estudiante'}</span><ChevronRight size={15} /></div>
          </div>
        </header>

        {activeTab === 'home' && <HomeView searchFrom={searchFrom} searchTo={searchTo} setSearchFrom={setSearchFrom} setSearchTo={setSearchTo} trips={visibleTrips} statuses={requestStatuses} onSelectTrip={setSelectedTrip} onDriver={openDriverAction} onHistory={() => setActiveTab('history')} />}
        {activeTab === 'requests' && <RequestsView key={requestsRefreshVersion} userId={user.id} isDriver={profile.role === 'DRIVER'} canPublish={isApprovedDriver} onPublish={() => setShowPublishFlow(true)} onOpenSafety={() => setActiveTab('safety')} />}
        {activeTab === 'history' && <HistoryView userId={user.id} isDriver={profile.role === 'DRIVER'} />}
        {activeTab === 'safety' && <SafetyView user={user} />}
        {activeTab === 'alerts' && <NotificationsView user={user} onChanged={() => { void loadUnread(user.id); }} onOpen={(target) => setActiveTab(target === 'trips' ? 'requests' : 'safety')} />}
        {activeTab === 'profile' && <ProfileView profile={profile} initials={initials} isApprovedDriver={isApprovedDriver} driverStatus={driverApplicationStatus?.status ?? null} onDriver={openDriverAction} onSignOut={signOut} />}
        {activeTab === 'admin' && profile?.role === 'ADMIN' && <AdminView />}

        <div className="mobile-nav">
          {visibleNavItems.map((item) => <NavButton key={item.id} item={item} active={activeTab === item.id} onClick={setActiveTab} badge={item.id === 'alerts' ? unreadCount : 0} />)}
        </div>
      </main>

      {showMenu && <MobileDrawer active={activeTab} isAdmin={profile?.role === 'ADMIN'} onClose={() => setShowMenu(false)} onSelect={(tab) => { setActiveTab(tab); setShowMenu(false); }} onDriver={() => { openDriverAction(); setShowMenu(false); }} />}
      {selectedTrip && <TripModal trip={selectedTrip} status={requestStatuses[selectedTrip.id]} user={user} onClose={() => setSelectedTrip(null)} onRequest={() => { void requestTrip(selectedTrip.id); }} />}
      {showDriverFlow && <DriverModal onClose={() => setShowDriverFlow(false)} onSubmit={(draft) => { void registerDriver(draft); }} status={driverApplicationStatus} />}
      {showPublishFlow && <PublishTripModal vehicles={approvedVehicles} onClose={() => setShowPublishFlow(false)} onPublish={(draft, vehicleId, route) => { void publishTrip(draft, vehicleId, route); }} />}
    </div>
  );
}

function Brand() {
  return <div className="brand"><div className="brand-mark"><Car size={22} strokeWidth={2.5} /></div><div><strong>Student<em>Go</em></strong><span>Tu comunidad, tu camino</span></div></div>;
}

function NavButton({ item, active, onClick, badge = 0 }: { item: typeof navItems[number]; active: boolean; onClick: (tab: Tab) => void; badge?: number }) {
  const Icon = item.icon;
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={() => onClick(item.id)}><Icon size={19} /><span>{item.label}</span>{badge > 0 && <b>{badge}</b>}</button>;
}

function HomeView({ searchFrom, searchTo, setSearchFrom, setSearchTo, trips: filteredTrips, statuses, onSelectTrip, onDriver, onHistory }: { searchFrom: string; searchTo: string; setSearchFrom: (value: string) => void; setSearchTo: (value: string) => void; trips: Trip[]; statuses: Record<string, TripStatus>; onSelectTrip: (trip: Trip) => void; onDriver: () => void; onHistory: () => void }) {
  return <div className="page-wrap">
    <section className="welcome-row"><div><p className="eyebrow">BIENVENIDA</p><h1>¿A dónde quieres ir hoy?</h1><p className="subheading">Viajes compartidos por estudiantes verificados</p></div><div className="welcome-orb"><Navigation size={27} /></div></section>
    <section className="hero-grid">
      <div className="search-card card-surface">
        <div className="card-heading"><div><p className="eyebrow">ENCUENTRA TU RUTA</p><h2>Busca un viaje</h2></div><div className="heading-icon"><Search size={18} /></div></div>
        <div className="route-inputs"><label><MapPin size={17} /><span>Desde</span><input value={searchFrom} onChange={(event) => setSearchFrom(event.target.value)} placeholder="Ej. UTP" /></label><div className="route-line" /><label><Navigation size={17} /><span>Hasta</span><input value={searchTo} onChange={(event) => setSearchTo(event.target.value)} placeholder="Ej. Casa" /></label></div>
        <button className="primary-button wide" onClick={() => document.getElementById('nearby-trips')?.scrollIntoView({ behavior: 'smooth' })}><Search size={17} /> Buscar viajes</button>
      </div>
      <MapCard />
    </section>
    <section className="quick-actions"><button className="quick-card" onClick={onDriver}><div className="quick-icon lavender"><Car size={20} /></div><span>Ofrecer viaje</span><small>Comparte tu camino</small></button><button className="quick-card" onClick={() => document.getElementById('nearby-trips')?.scrollIntoView({ behavior: 'smooth' })}><div className="quick-icon blue"><Search size={20} /></div><span>Buscar viaje</span><small>Llega más lejos</small></button><button className="quick-card" onClick={onHistory}><div className="quick-icon peach"><Clock3 size={20} /></div><span>Historial</span><small>Consulta tus viajes</small></button></section>
    <section id="nearby-trips" className="trips-section"><div className="section-header"><div><p className="eyebrow">CERCA DE TI</p><h2>Viajes disponibles</h2></div></div><div className="trip-list">{filteredTrips.length ? filteredTrips.map((trip) => <TripCard key={trip.id} trip={trip} status={statuses[trip.id]} onSelect={() => onSelectTrip(trip)} />) : <div className="empty-state"><Search size={24} /><strong>No encontramos viajes disponibles</strong><span>Prueba cambiando el origen o destino.</span></div>}</div></section>
  </div>;
}

function MapCard() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!containerRef.current) return;
    const map = createMap(containerRef.current, { lat: 19.0497, lng: -98.2195 }, 14);
    addMarker(map, { lat: 19.0497, lng: -98.2195 }, 'UTP Puebla');
    return () => { map.remove(); };
  }, []);
  return <div className="map-card"><div className="map-toolbar"><span><span className="live-dot" /> Mapa UTP</span><button onClick={async () => { try { const pos = await getCurrentPosition(); setStatus(`Ubicación actual de este dispositivo: ${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`); } catch (err) { setStatus((err as Error).message); } }}><Crosshair size={16} /></button></div><div ref={containerRef} className="leaflet-container-custom" /><div className="map-bottom"><span>{status || 'Zona UTP · mapa de referencia'}</span><strong>OpenStreetMap</strong></div></div>;
}

function TripCard({ trip, status, onSelect }: { trip: Trip; status?: TripStatus; onSelect: () => void }) {
  return <article className="trip-card"><div className="trip-main"><div className="avatar trip-avatar" style={{ background: trip.color }}>{trip.initials}</div><div className="trip-copy"><strong>{trip.driver}</strong><span>{trip.car}</span></div><div className="trip-price"><strong>${trip.price}</strong><span>MXN</span></div></div><div className="trip-route"><div><span className="route-dot purple" />{trip.from}</div><div className="route-connector" /><div><span className="route-dot dark" />{trip.to}</div></div><div className="trip-meta"><span><Clock3 size={14} /> {trip.time}</span><span><UsersRound size={14} /> {trip.seats} lugares</span>{status ? <span className={`status-pill ${status.toLowerCase()}`}>{status === 'PENDING' ? 'Pendiente' : status === 'ACCEPTED' ? 'Aceptado' : status === 'COMPLETED' ? 'Completado' : status}</span> : <button className="small-button" onClick={onSelect}>Solicitar</button>}</div></article>;
}


function ProfileView({ profile, initials, isApprovedDriver, driverStatus, onDriver, onSignOut }: { profile: Profile | null; initials: string; isApprovedDriver: boolean; driverStatus: DriverApplicationStatus['status'] | null; onDriver: () => void; onSignOut: () => void }) {
  return <div className="page-wrap profile-page">
    <div className="profile-hero card-surface"><div className="profile-avatar">{initials}</div><h1>{profile?.full_name ?? 'Estudiante'}</h1><p>{profile?.career ?? 'Perfil de estudiante'}</p><span className="student-id">Matrícula: {profile?.student_number ?? '—'}</span></div>
    <button className="driver-banner" onClick={onDriver}><div className="quick-icon lavender"><Car size={22} /></div><div><strong>{isApprovedDriver ? 'Conductor aprobado' : driverStatus === 'PENDING_REVIEW' ? 'Solicitud de conductor en revisión' : 'Conviértete en conductor'}</strong><span>{isApprovedDriver ? 'Publica tu próximo viaje desde aquí.' : driverStatus === 'PENDING_REVIEW' ? 'Tu registro está pendiente de revisión administrativa.' : 'Comparte tu auto y ayuda a otros estudiantes.'}</span></div><ChevronRight size={19} /></button>
    {profile && <EmergencyContactsEditor userId={profile.id} />}
    {profile && <PasskeySettings key={profile.id} userId={profile.id} />}
    <button className="logout" onClick={() => { void onSignOut(); }}><span className="option-icon option-danger"><LogOut size={17} /></span>Cerrar sesión</button>
  </div>;
}


type DriverReview = { id: string; user_id: string; status: string; submitted_at: string | null; rejection_reason: string | null; vehicle: { id: string; brand: string; model: string; plates: string; vehicle_year: number; color: string; license_path: string; registration_card_path: string } | null };

function AdminView() {
  const [reviews, setReviews] = useState<DriverReview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [links, setLinks] = useState<{ license: string; registration: string }>({ license: '', registration: '' });
  const [message, setMessage] = useState('');

  const load = useCallback(async (): Promise<void> => {
    const { data, error } = await supabase.from('driver_applications').select('id, user_id, status, submitted_at, rejection_reason, vehicles(id, brand, model, plates, vehicle_year, color, license_path, registration_card_path)').eq('status', 'PENDING_REVIEW').order('submitted_at');
    if (error) { setMessage('No pudimos cargar las solicitudes.'); return; }
    setReviews((data ?? []).map((item) => ({ ...item, vehicle: Array.isArray(item.vehicles) ? item.vehicles[0] ?? null : item.vehicles })) as DriverReview[]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function openDocuments(review: DriverReview): Promise<void> {
    if (!review.vehicle) return;
    const [license, registration] = await Promise.all([
      supabase.storage.from('student-documents').createSignedUrl(review.vehicle.license_path, 300),
      supabase.storage.from('student-documents').createSignedUrl(review.vehicle.registration_card_path, 300),
    ]);
    if (license.error || registration.error) { setMessage('No pudimos abrir los documentos privados.'); return; }
    setLinks({ license: license.data.signedUrl, registration: registration.data.signedUrl }); setSelected(review.id); setReason('');
  }

  async function review(approved: boolean): Promise<void> {
    if (!selected || (!approved && reason.trim().length < 5)) { setMessage('Escribe un motivo de al menos 5 caracteres para rechazar.'); return; }
    const { data, error } = await supabase.rpc('review_driver_application', { p_application_id: selected, p_approved: approved, p_reason: reason.trim() || null });
    if (error || !data?.[0]?.ok) { setMessage('No se pudo guardar la revisión.'); return; }
    setMessage(approved ? 'Conductor aprobado.' : 'Solicitud rechazada.'); setSelected(null); setLinks({ license: '', registration: '' }); await load();
  }

  const current = reviews.find((item) => item.id === selected);
  return <div className="page-wrap"><div className="page-title"><div><p className="eyebrow">ADMINISTRACIÓN</p><h1>Revisión de conductores</h1><p>Las solicitudes permanecen pendientes hasta una decisión administrativa.</p></div></div>{message && <div className="sos-status">{message}</div>}{reviews.length === 0 ? <div className="empty-panel"><h3>No hay solicitudes pendientes</h3><p>Cuando un estudiante envíe documentos aparecerá aquí.</p></div> : reviews.map((reviewItem) => <div className="driver-request-card" key={reviewItem.id}><strong>{reviewItem.vehicle ? `${reviewItem.vehicle.brand} ${reviewItem.vehicle.model}` : 'Vehículo sin datos'}</strong><span>{reviewItem.vehicle?.plates ?? 'Sin placas'} · {reviewItem.vehicle?.vehicle_year ?? '—'} · {reviewItem.vehicle?.color ?? '—'}</span><small>{reviewItem.submitted_at ? new Date(reviewItem.submitted_at).toLocaleString('es-MX') : 'Sin fecha'}</small><button className="small-button" onClick={() => { void openDocuments(reviewItem); }}>Revisar documentos</button></div>)}{current && <div className="modal-backdrop"><div className="modal-card driver-modal"><button className="modal-close" onClick={() => setSelected(null)}><X size={18} /></button><p className="eyebrow center">SOLICITUD PENDIENTE</p><h2>{current.vehicle?.brand} {current.vehicle?.model}</h2><a className="secondary-button wide" href={links.license} target="_blank" rel="noreferrer">Abrir licencia privada</a><a className="secondary-button wide" href={links.registration} target="_blank" rel="noreferrer">Abrir tarjeta privada</a><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motivo si rechazas la solicitud" /><div className="sos-buttons"><button className="primary-button" onClick={() => { void review(true); }}>Aprobar</button><button className="secondary-button" onClick={() => { void review(false); }}>Rechazar</button></div></div></div>}</div>;
}


function TripModal({ trip, status, onClose, onRequest }: { trip: Trip; status?: TripStatus; user: User; onClose: () => void; onRequest: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!trip.origin || !trip.destination || !containerRef.current) return;
    const map = createMap(containerRef.current, trip.origin, 13);
    addMarker(map, trip.origin, 'Origen'); addMarker(map, trip.destination, 'Destino');
    void getRoute(trip.origin, trip.destination).then((route) => { if (route) { drawRoute(map, route.geometry); fitToRoute(map, route.geometry); } });
    return () => { map.remove(); };
  }, [trip]);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card trip-modal" onMouseDown={(event) => event.stopPropagation()}>
    <button className="modal-close" onClick={onClose}><X size={18} /></button><div ref={containerRef} className="leaflet-container-custom modal-map" />
    <div className="modal-content"><p className="eyebrow">DETALLE DEL VIAJE</p><h2>{trip.route}</h2>
      <div className="detail-grid"><div><MapPin size={17} /><span>Salida<strong>{trip.time}</strong></span></div><div><Car size={17} /><span>Vehículo<strong>{trip.car}</strong></span></div><div><UsersRound size={17} /><span>Disponibles<strong>{trip.seats} lugares</strong></span></div><div><Navigation size={17} /><span>Distancia<strong>{trip.distanceKm.toFixed(1)} km · {Math.round(trip.durationMin)} min</strong></span></div></div>
      <div className="fare-card"><p className="eyebrow">TARIFA DEFINIDA POR EL CONDUCTOR</p><strong>${trip.price} MXN</strong><span>Monto informado al publicar el viaje.</span></div>
      {status ? <div className="request-confirmed"><Check size={20} /><div><strong>{status === 'PENDING' ? 'Solicitud enviada' : status === 'ACCEPTED' ? 'Viaje confirmado' : status === 'COMPLETED' ? 'Viaje completado' : `Solicitud ${status}`}</strong><span>{status === 'PENDING' ? 'Te avisaremos cuando el conductor responda.' : 'Tu lugar está reservado.'}</span></div></div> : <button className="primary-button wide" onClick={onRequest}>Solicitar lugar <ChevronRight size={17} /></button>}
      <button className="secondary-button wide" onClick={onClose}>Cerrar</button></div>
  </div></div>;
}

function DriverModal({ onClose, onSubmit, status }: { onClose: () => void; onSubmit: (draft: DriverRegistrationDraft) => void; status: DriverApplicationStatus | null }) {
  const [draft, setDraft] = useState<DriverRegistrationDraft>({ brand: '', model: '', year: new Date().getFullYear(), color: '', plates: '', capacity: 4, license: null, registrationCard: null, licenseExpiresAt: '', registrationExpiresAt: '' });
  const update = <K extends keyof DriverRegistrationDraft>(key: K, value: DriverRegistrationDraft[K]): void => setDraft((current) => ({ ...current, [key]: value }));
  const valid = draft.brand.trim() && draft.model.trim() && draft.color.trim() && /^[A-Za-z0-9 -]{5,10}$/.test(draft.plates) && draft.year >= 1950 && draft.license && draft.registrationCard && draft.licenseExpiresAt >= new Date().toISOString().slice(0, 10) && draft.registrationExpiresAt >= new Date().toISOString().slice(0, 10);
  const labels: Record<DriverApplicationStatus['status'], string> = { INCOMPLETE: 'Registro incompleto', PENDING_REVIEW: 'Pendiente de revisión', APPROVED: 'Conductor aprobado', REJECTED: 'Solicitud rechazada' };
  if (status?.status === 'PENDING_REVIEW' || status?.status === 'APPROVED') return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card driver-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose}><X size={18} /></button><div className="driver-illustration"><Car size={54} /></div><p className="eyebrow center">REGISTRO DE CONDUCTOR</p><h2>{status.status === 'PENDING_REVIEW' ? '¡Solicitud enviada correctamente!' : '¡Conductor aprobado!'}</h2><p className="modal-lead">{status.status === 'PENDING_REVIEW' ? 'Tu registro como conductor está pendiente de revisión por el equipo de Student Go. Te notificaremos cuando exista una decisión.' : 'Ya puedes publicar viajes con tus vehículos aprobados.'}</p><div className="request-confirmed"><Check size={20} /><div><strong>{labels[status.status]}</strong><span>{status.submitted_at ? `Solicitud enviada el ${new Date(status.submitted_at).toLocaleDateString('es-MX')}.` : 'Estado actualizado.'}</span></div></div><button className="secondary-button wide" onClick={onClose}>Cerrar</button></div></div>;
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card driver-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose}><X size={18} /></button><div className="driver-illustration"><Car size={54} /></div><p className="eyebrow center">REGISTRO DE CONDUCTOR</p><h2>{status?.status === 'REJECTED' ? 'Corrige tu registro' : 'Verifica tu vehículo'}</h2><p className="modal-lead">{status?.status === 'REJECTED' ? `Solicitud rechazada. Motivo: ${status.rejection_reason || 'Revisa tus documentos y vuelve a enviarlos.'}` : 'Este proceso es independiente de publicar viajes. Un administrador revisará tus documentos antes de aprobarte.'}</p><div className="form-grid"><label>Marca<input value={draft.brand} onChange={(event) => update('brand', event.target.value)} placeholder="Nissan" /></label><label>Modelo<input value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="Versa" /></label><label>Año<input type="number" min="1950" max="2100" value={draft.year} onChange={(event) => update('year', Number(event.target.value))} /></label><label>Color<input value={draft.color} onChange={(event) => update('color', event.target.value)} placeholder="Blanco" /></label><label>Placas<input value={draft.plates} onChange={(event) => update('plates', event.target.value.toUpperCase())} placeholder="ABC-123" /></label><label>Capacidad<select value={draft.capacity} onChange={(event) => update('capacity', Number(event.target.value))}><option value={1}>1 pasajero</option><option value={4}>4 pasajeros</option><option value={5}>5 pasajeros</option><option value={7}>7 pasajeros</option></select></label></div><div className="form-grid"><label>Vigencia licencia<input type="date" value={draft.licenseExpiresAt} onChange={(event) => update('licenseExpiresAt', event.target.value)} /></label><label>Vigencia tarjeta<input type="date" value={draft.registrationExpiresAt} onChange={(event) => update('registrationExpiresAt', event.target.value)} /></label></div><label className="secondary-button wide file-label">Licencia vigente<input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => update('license', event.target.files?.[0] ?? null)} hidden /></label><label className="secondary-button wide file-label">Tarjeta de circulación<input type="file" accept="image/jpeg,image/png,application/pdf" onChange={(event) => update('registrationCard', event.target.files?.[0] ?? null)} hidden /></label><button className="primary-button wide" disabled={!valid} onClick={() => onSubmit(draft)}>{status?.status === 'REJECTED' ? 'Reenviar a revisión' : 'Enviar a revisión'} <ChevronRight size={17} /></button></div></div>;
}


function PublishTripModal({ vehicles, onClose, onPublish }: { vehicles: Array<{ id: string; label: string; capacity: number }>; onClose: () => void; onPublish: (draft: PublishDraft, vehicleId: string, route: RouteInfo | null) => void }) {
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '');
  const [draft, setDraft] = useState<PublishDraft>({ origin: null, destination: null, originLabel: '', destinationLabel: '', departureAt: new Date(Date.now() + 3600000).toISOString().slice(0, 16), availableSeats: 1, fare: 0 });
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [searching, setSearching] = useState(false);
  const vehicle = vehicles.find((item) => item.id === vehicleId);
  async function calculateRoute(): Promise<void> { if (!draft.origin || !draft.destination) return; setSearching(true); setRoute(await getRoute(draft.origin, draft.destination)); setSearching(false); }
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card driver-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={onClose}><X size={18} /></button><p className="eyebrow center">PUBLICAR VIAJE</p><h2>Comparte tu camino</h2>
    <label className="form-label">Vehículo aprobado<select value={vehicleId} onChange={(event) => setVehicleId(event.target.value)}>{vehicles.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    <PlaceSearch label="Origen" value={draft.originLabel} onSelect={(place) => setDraft({ ...draft, origin: { lat: place.lat, lng: place.lng }, originLabel: place.label })} />
    <PlaceSearch label="Destino" value={draft.destinationLabel} onSelect={(place) => setDraft({ ...draft, destination: { lat: place.lat, lng: place.lng }, destinationLabel: place.label })} />
    <label className="form-label">Fecha y hora<input type="datetime-local" value={draft.departureAt} onChange={(event) => setDraft({ ...draft, departureAt: event.target.value })} /></label>
    <label className="form-label">Lugares disponibles<select value={draft.availableSeats} onChange={(event) => setDraft({ ...draft, availableSeats: Number(event.target.value) })}>{Array.from({ length: vehicle?.capacity ?? 1 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}</select></label>
    <label className="form-label">Tarifa por pasajero (MXN)<input type="number" min="0" step="1" value={draft.fare || ''} onChange={(event) => setDraft({ ...draft, fare: Number(event.target.value) })} placeholder="Ej. 25" /></label>
    <button className="secondary-button wide" disabled={!draft.origin || !draft.destination || searching} onClick={() => { void calculateRoute(); }}>{searching ? 'Calculando ruta...' : 'Calcular ruta'}</button>
    {route && <div className="fare-card"><span>{route.distanceKm.toFixed(1)} km · {Math.round(route.durationMin)} min</span><strong>${draft.fare || 0} MXN</strong><span>Tarifa definida manualmente por el conductor.</span></div>}
    <button className="primary-button wide" disabled={!route || !vehicleId || draft.fare < 0} onClick={() => onPublish(draft, vehicleId, route)}>Publicar viaje</button>
  </div></div>;
}

function PlaceSearch({ label, value, onSelect }: { label: string; value: string; onSelect: (place: { lat: number; lng: number; label: string }) => void }) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Array<{ lat: number; lng: number; label: string }>>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => { setQuery(value); }, [value]);
  async function doSearch() {
    if (!query.trim()) return;
    setSearching(true);
    const r = await searchPlace(query);
    setResults(r);
    setSearching(false);
  }
  return <div className="place-search"><label className="form-label">{label}<div className="place-input-row"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Busca una dirección" /><button type="button" onClick={() => { void doSearch(); }}><Search size={16} /></button></div></label>{results.length > 0 && <ul className="place-results">{results.map((r, i) => <li key={i} onClick={() => { onSelect(r); setQuery(r.label); setResults([]); }}><MapPin size={14} /> {r.label}</li>)}</ul>}{searching && <span className="scanner-status">Buscando...</span>}</div>;
}

function MobileDrawer({ active, isAdmin, onClose, onSelect, onDriver }: { active: Tab; isAdmin: boolean; onClose: () => void; onSelect: (tab: Tab) => void; onDriver: () => void }) {
  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="mobile-drawer" onMouseDown={(e) => e.stopPropagation()}>
    <div className="drawer-header"><Brand /><button onClick={onClose}><X size={20} /></button></div>
    {navItems.filter((item) => isAdmin || item.id !== 'admin').map((item) => <NavButton key={item.id} item={item} active={active === item.id} onClick={onSelect} />)}
    <button className="driver-prompt" onClick={onDriver}><div className="driver-prompt-icon"><Car size={20} /></div><div><strong>¿Tienes auto?</strong><span>Conviértete en conductor</span></div><ChevronRight size={17} /></button>
  </aside></div>;
}

type SignupDraft = { name: string; lastName: string; matricula: string; career: string; group: string; phone: string; email: string; password: string; };
type SignupEmergencyContact = { name: string; relationship: string; phone: string; whatsappConsent: boolean };

function AuthScreen({ error, onError }: { error: string; onError: (message: string) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [showPassword, setShowPassword] = useState(false);
  const [draft, setDraft] = useState<SignupDraft>({ name: '', lastName: '', matricula: '', career: '', group: '', phone: '', email: '', password: '' });
  const [contacts, setContacts] = useState<[SignupEmergencyContact, SignupEmergencyContact]>([{ name: '', relationship: '', phone: '', whatsappConsent: false }, { name: '', relationship: '', phone: '', whatsappConsent: false }]);
  const [consent, setConsent] = useState(false); const [busy, setBusy] = useState(false);
  const passwordRules: Array<[string, boolean]> = [['8 caracteres o más', password.length >= 8], ['Una mayúscula', /[A-ZÁÉÍÓÚÑ]/.test(password)], ['Un número', /\d/.test(password)], ['Un símbolo', /[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/.test(password)]];
  const passwordStrong = passwordRules.every(([, met]) => met);
  function updateContact(index: number, change: Partial<SignupEmergencyContact>): void { setContacts((current) => { const next: [SignupEmergencyContact, SignupEmergencyContact] = [...current]; next[index] = { ...next[index], ...change }; return next; }); }
  async function signIn(): Promise<void> {
    if (busy) return;
    setBusy(true); onError('');
    try {
      const result = await supabase.auth.signInWithPassword({ email, password });
      if (result.error) onError('No pudimos iniciar sesión. Revisa tu correo y contraseña.');
    } catch { onError('No pudimos conectar. Revisa tu conexión e intenta otra vez.'); }
    finally { setBusy(false); }
  }
  async function signUp(): Promise<void> {
    if (busy) return;
    const fullName = `${draft.name} ${draft.lastName}`.trim(); const phonesValid = contacts.every((contact) => /^\+[1-9][0-9]{9,14}$/.test(contact.phone.replace(/[\s()-]/g, '')));
    if (!fullName || !draft.matricula.trim() || !draft.email.trim() || !passwordStrong || password !== confirmPassword || !phonesValid || contacts.some((contact) => !contact.name.trim() || !contact.relationship.trim() || !contact.whatsappConsent) || !consent) { onError('Completa tus datos, los dos contactos con autorización de WhatsApp y una contraseña segura que coincida.'); return; }
    setBusy(true); onError('');
    try {
      const result = await supabase.auth.signUp({ email: draft.email.trim(), password, options: { data: { full_name: fullName, student_number: draft.matricula.trim(), career: draft.career.trim() || null, whatsapp_alerts_consent: true, emergency_contacts: contacts.map((contact) => ({ name: contact.name.trim(), relationship: contact.relationship.trim(), phone: contact.phone.replace(/[\s()-]/g, ''), whatsapp_consent: true })) } } });
      if (result.error) onError('No pudimos crear tu cuenta. Revisa los datos e intenta otra vez.');
      else onError('Cuenta creada. Confirma tu correo si se solicita e inicia sesión para activar el acceso con huella, rostro o PIN.');
    } catch { onError('No pudimos conectar. Revisa tu conexión e intenta otra vez.'); }
    finally { setBusy(false); }
  }
  return <div className={`auth-screen ${mode === 'signup' ? 'signup-screen' : ''}`}><div className="auth-art"><Brand /><div className="auth-car"><Car size={86} /><div className="auth-route"><MapPin size={19} /><span /><MapPin size={19} /></div></div><h1>Comparte tu camino,<br /><em>llega más lejos.</em></h1><p>Movilidad universitaria hecha para compartir el camino.</p></div>
    <form className={`auth-card ${mode === 'signup' ? 'signup-auth-card' : ''}`} onSubmit={(event) => { event.preventDefault(); if (mode === 'login') void signIn(); else void signUp(); }}><p className="eyebrow">STUDENTGO</p><h2>{mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</h2><p className="auth-lead">{mode === 'login' ? 'Vuelve a tu comunidad universitaria.' : 'Registra tus datos y tus dos contactos de confianza.'}</p>{error && <div className="auth-error">{error}</div>}
      {mode === 'signup' && <>
        <p className="passkey-help">Después de crear y confirmar tu cuenta podrás activar una clave de acceso para entrar con huella, rostro o PIN.</p>
        <div className="signup-details-grid">
          <label>Nombre<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Ej. Arely" required /></label>
          <label>Apellidos<input value={draft.lastName} onChange={(event) => setDraft({ ...draft, lastName: event.target.value })} placeholder="Ej. Basurto Cruz" required /></label>
          <label>Matrícula<input value={draft.matricula} onChange={(event) => setDraft({ ...draft, matricula: event.target.value })} placeholder="Ej. 12345678" required /></label>
          <label>Carrera<input value={draft.career} onChange={(event) => setDraft({ ...draft, career: event.target.value })} placeholder="Ej. Ingeniería en Software" required /></label>
          <label>Grupo<input value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} placeholder="Ej. A" required /></label>
          <label>Teléfono<input type="tel" value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} placeholder="Ej. 2211234567" required /></label>
          <label className="signup-full-field">Correo institucional<input type="email" value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} placeholder="2311081469@alumno.utpuebla.edu.mx" required /></label>
        </div>
        <fieldset className="signup-emergency-contacts"><legend>Dos contactos de emergencia para WhatsApp</legend><p>Registra personas que ya aceptaron recibir avisos de seguridad. Usa el número con lada internacional.</p><div className="signup-contacts-grid">{contacts.map((contact, index) => <div className="signup-emergency-contact" key={index}><strong>Contacto {index + 1}</strong><label>Nombre completo<input value={contact.name} onChange={(event) => updateContact(index, { name: event.target.value })} placeholder="Nombre completo" required /></label><label>Parentesco o relación<input value={contact.relationship} onChange={(event) => updateContact(index, { relationship: event.target.value })} placeholder="Ej. Mamá" required /></label><label className="contact-phone-field">Celular con lada<input type="tel" value={contact.phone} onChange={(event) => updateContact(index, { phone: event.target.value })} placeholder="+52 222 123 4567" required /></label><label className="consent-line"><input type="checkbox" checked={contact.whatsappConsent} onChange={(event) => updateContact(index, { whatsappConsent: event.target.checked })} required /> Confirmo que esta persona aceptó recibir avisos por WhatsApp.</label></div>)}</div></fieldset>
        <div className="signup-details-grid password-grid"><label>Contraseña<div className="password-input"><input type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo 8 caracteres" required minLength={8} /><button type="button" onClick={() => setShowPassword((current) => !current)} aria-label="Mostrar u ocultar contraseña">{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><ul className="password-rules">{passwordRules.map(([label, met]) => <li className={met ? 'valid' : ''} key={label}>{met ? '✓' : '×'} {label}</li>)}</ul></label><label>Confirmar contraseña<input type={showPassword ? 'text' : 'password'} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repite tu contraseña" required minLength={8} />{confirmPassword && password !== confirmPassword && <span className="field-error">Las contraseñas no coinciden.</span>}</label></div>
        <label className="consent-line location-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} required /> Acepto que StudentGo solicite mi ubicación únicamente si activo Acompañamiento Inteligente.</label>
      </>}
      {mode === 'login' && <><PasskeySignIn disabled={busy} onBusyChange={setBusy} onError={onError} /><label>Correo de alumno<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="2311081469@alumno.utpuebla.edu.mx" required /></label><label>Contraseña<div className="password-input"><input type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Tu contraseña" required minLength={8} /><button type="button" onClick={() => setShowPassword((current) => !current)} aria-label="Mostrar u ocultar contraseña">{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label></>}
      <button className="primary-button wide" type="submit" disabled={busy}>{busy ? 'Procesando...' : mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}</button><button type="button" className="auth-switch" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); onError(''); }}>{mode === 'login' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Inicia sesión'}</button>
    </form></div>;
}


export default App;
