import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bell, CarFront, Check, ClipboardCheck, Clock3, ExternalLink, FileCheck2,
  GraduationCap, LayoutDashboard, LogOut, Megaphone, RefreshCw, Route, Search, Settings,
  ShieldCheck, Siren, Users, X,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import SosIncidentDetail from '@/components/SosIncidentDetail';
import PasskeySettings from '@/components/PasskeySettings';

type AdminSection = 'overview' | 'applications' | 'students' | 'trips' | 'sos' | 'notices' | 'settings';
type AdminProfile = { id: string; full_name: string; email: string };
type StudentRow = { id: string; full_name: string; email: string; student_number: string; role: string; student_verified: boolean; driver_verified: boolean; updated_at: string };
type ApplicationRow = { id: string; user_id: string; status: string; submitted_at: string | null; approved_at: string | null; approved_by: string | null; reviewed_at: string | null; reviewed_by: string | null; rejection_reason: string | null; applicant: { full_name: string; email: string; student_number: string | null } | null; reviewer: { full_name: string } | null; vehicle: { id: string; brand: string; model: string; plates: string; vehicle_year: number; color: string; license_path: string; registration_card_path: string } | null };
type ApplicationTab = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
type TripRow = { id: string; origin_text: string; destination_text: string; departure_at: string; status: string; vehicle_name: string; driver_id: string };
type SosRow = { id: string; trip_id: string | null; role: string; message: string | null; status: string; created_at: string; resolved_at: string | null; latitude: number | null; longitude: number | null; resolution_note: string | null };
type Announcement = { id: string; title: string; message: string; type: string; published: boolean; created_at: string };

type NavItem = { id: AdminSection; label: string; icon: typeof LayoutDashboard };
const navItems: NavItem[] = [
  { id: 'overview', label: 'Panel general', icon: LayoutDashboard },
  { id: 'applications', label: 'Solicitudes', icon: ClipboardCheck },
  { id: 'students', label: 'Estudiantes', icon: GraduationCap },
  { id: 'trips', label: 'Viajes', icon: Route },
  { id: 'sos', label: 'Incidentes SOS', icon: Siren },
  { id: 'notices', label: 'Avisos', icon: Megaphone },
  { id: 'settings', label: 'Configuración', icon: Settings },
];

export default function AdminDashboard({ profile, onSignOut }: { profile: AdminProfile; onSignOut: () => void }) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [communityProfiles, setCommunityProfiles] = useState<StudentRow[]>([]);
  const [applications, setApplications] = useState<ApplicationRow[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [sosAlerts, setSosAlerts] = useState<SosRow[]>([]);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [applicationTab, setApplicationTab] = useState<ApplicationTab>('PENDING_REVIEW');
  const [applicationSearch, setApplicationSearch] = useState('');
  const [selectedApplication, setSelectedApplication] = useState<ApplicationRow | null>(null);
  const [documentLinks, setDocumentLinks] = useState<{ license: string; registration: string }>({ license: '', registration: '' });
  const [reviewReason, setReviewReason] = useState('');
  const [noticeDraft, setNoticeDraft] = useState({ title: '', message: '', type: 'GENERAL' });

  const loadDashboard = useCallback(async (): Promise<void> => {
    setLoading(true);
    const [studentsResult, applicationsResult, tripsResult, sosResult, noticesResult] = await Promise.all([
      supabase.from('profiles').select('id, full_name, email, student_number, role, student_verified, driver_verified, updated_at').order('updated_at', { ascending: false }),
      supabase.from('driver_applications').select('id, user_id, status, submitted_at, approved_at, approved_by, reviewed_at, reviewed_by, rejection_reason, vehicles(id, brand, model, plates, vehicle_year, color, license_path, registration_card_path)').order('submitted_at', { ascending: false }),
      supabase.from('trips').select('id, origin_text, destination_text, departure_at, status, vehicle_name, driver_id').order('departure_at', { ascending: false }).limit(100),
      supabase.from('sos_alerts').select('id, trip_id, role, message, status, created_at, resolved_at, latitude, longitude, resolution_note').order('created_at', { ascending: false }).limit(100),
      supabase.from('admin_announcements').select('id, title, message, type, published, created_at').order('created_at', { ascending: false }),
    ]);
    if (studentsResult.error || applicationsResult.error || tripsResult.error || sosResult.error || noticesResult.error) setMessage('No se pudieron cargar todos los datos del panel.');
    const community = (studentsResult.data ?? []) as StudentRow[];
    setCommunityProfiles(community);
    setStudents(community.filter((student) => student.role === 'STUDENT'));
    const profilesById = new Map(community.map((item) => [item.id, item]));
    setApplications((applicationsResult.data ?? []).map((item) => ({
      ...item,
      applicant: profilesById.get(item.user_id) ?? null,
      reviewer: profilesById.get(item.reviewed_by ?? item.approved_by ?? '') ?? null,
      vehicle: Array.isArray(item.vehicles) ? item.vehicles[0] ?? null : item.vehicles,
    })) as ApplicationRow[]);
    setTrips((tripsResult.data ?? []) as TripRow[]);
    setSosAlerts((sosResult.data ?? []) as SosRow[]);
    setAnnouncements((noticesResult.data ?? []) as Announcement[]);
    setLoading(false);
  }, []);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    const refreshIncidents = async (): Promise<void> => {
      const { data, error } = await supabase.from('sos_alerts')
        .select('id, trip_id, role, message, status, created_at, resolved_at, latitude, longitude, resolution_note')
        .order('created_at', { ascending: false }).limit(100);
      if (!error && data) setSosAlerts(data as SosRow[]);
    };
    const timer = window.setInterval(() => { void refreshIncidents(); }, 15000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredStudents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return students;
    return students.filter((student) => `${student.full_name} ${student.email} ${student.student_number}`.toLowerCase().includes(query));
  }, [search, students]);

  const filteredApplications = useMemo(() => {
    const query = applicationSearch.trim().toLowerCase();
    return applications.filter((application) => {
      if (application.status !== applicationTab) return false;
      if (!query) return true;
      return `${application.applicant?.full_name ?? ''} ${application.applicant?.email ?? ''} ${application.applicant?.student_number ?? ''} ${application.vehicle?.brand ?? ''} ${application.vehicle?.model ?? ''} ${application.vehicle?.plates ?? ''}`.toLowerCase().includes(query);
    });
  }, [applicationSearch, applicationTab, applications]);

  const applicationCounts = useMemo(() => ({
    PENDING_REVIEW: applications.filter((application) => application.status === 'PENDING_REVIEW').length,
    APPROVED: applications.filter((application) => application.status === 'APPROVED').length,
    REJECTED: applications.filter((application) => application.status === 'REJECTED').length,
  }), [applications]);

  const stats = useMemo(() => ({
    students: communityProfiles.filter((profile) => profile.role === 'STUDENT').length,
    drivers: communityProfiles.filter((profile) => profile.role === 'DRIVER').length,
    administrators: communityProfiles.filter((profile) => profile.role === 'ADMIN').length,
    verified: communityProfiles.filter((profile) => profile.role === 'STUDENT' && profile.student_verified).length,
    pending: applicationCounts.PENDING_REVIEW,
    activeTrips: trips.filter((trip) => ['PUBLISHED', 'FULL', 'IN_PROGRESS'].includes(trip.status)).length,
    activeSos: sosAlerts.filter((alert) => alert.status !== 'RESOLVED').length,
  }), [applicationCounts.PENDING_REVIEW, communityProfiles, sosAlerts, trips]);

  async function openDocuments(application: ApplicationRow): Promise<void> {
    if (!application.vehicle) return;
    const [license, registration] = await Promise.all([
      supabase.storage.from('student-documents').createSignedUrl(application.vehicle.license_path, 300),
      supabase.storage.from('student-documents').createSignedUrl(application.vehicle.registration_card_path, 300),
    ]);
    if (license.error || registration.error) { setMessage('No se pudieron abrir los documentos privados.'); return; }
    setDocumentLinks({ license: license.data.signedUrl, registration: registration.data.signedUrl });
    setSelectedApplication(application);
    setReviewReason('');
  }

  async function reviewApplication(approved: boolean): Promise<void> {
    if (!selectedApplication || selectedApplication.status !== 'PENDING_REVIEW' || (!approved && reviewReason.trim().length < 5)) { setMessage('Escribe un motivo de al menos 5 caracteres para rechazar.'); return; }
    const { data, error } = await supabase.rpc('review_driver_application', { p_application_id: selectedApplication.id, p_approved: approved, p_reason: reviewReason.trim() || null });
    if (error || !data?.[0]?.ok) { setMessage('No se pudo guardar la revisión.'); return; }
    setMessage(approved ? 'Solicitud aprobada.' : 'Solicitud rechazada.');
    setSelectedApplication(null);
    await loadDashboard();
  }

  async function createNotice(): Promise<void> {
    if (noticeDraft.title.trim().length < 3 || noticeDraft.message.trim().length < 3) { setMessage('Completa el título y el mensaje del aviso.'); return; }
    const { error } = await supabase.from('admin_announcements').insert({ title: noticeDraft.title.trim(), message: noticeDraft.message.trim(), type: noticeDraft.type, created_by: profile.id });
    if (error) { setMessage('No se pudo publicar el aviso.'); return; }
    setNoticeDraft({ title: '', message: '', type: 'GENERAL' });
    setMessage('Aviso publicado.');
    await loadDashboard();
  }

  async function deleteNotice(id: string): Promise<void> {
    const { error } = await supabase.from('admin_announcements').delete().eq('id', id);
    if (error) { setMessage('No se pudo eliminar el aviso.'); return; }
    await loadDashboard();
  }

  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <div className="admin-brand"><div className="admin-brand-mark"><ShieldCheck size={22} /></div><div><strong>Student Go</strong><span>Centro administrativo</span></div></div>
      <div className="admin-account"><div className="admin-avatar">{profile.full_name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</div><div><strong>{profile.full_name}</strong><span>ADMIN autorizado</span></div></div>
      <nav className="admin-nav">{navItems.map((item) => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => { setSection(item.id); setMessage(''); }}><item.icon size={18} /><span>{item.label}</span>{item.id === 'applications' && stats.pending > 0 && <b>{stats.pending}</b>}</button>)}</nav>
      <button className="admin-logout" onClick={onSignOut}><LogOut size={17} /> Cerrar sesión</button>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div><span className="admin-kicker">STUDENT GO / ADMINISTRACIÓN</span><h1>{navItems.find((item) => item.id === section)?.label}</h1></div><div className="admin-top-actions"><span className="admin-role"><ShieldCheck size={15} /> Rol ADMIN verificado</span><button onClick={() => { void loadDashboard(); }} aria-label="Actualizar panel"><RefreshCw size={17} /></button></div></header>
      {message && <div className="admin-message">{message}</div>}
      {loading ? <div className="admin-loading"><RefreshCw size={22} /> Cargando información segura...</div> : <>
        {section === 'overview' && <Overview stats={stats} profiles={communityProfiles} sosAlerts={sosAlerts} onNavigate={setSection} />}
        {section === 'applications' && <Applications applications={filteredApplications} counts={applicationCounts} activeTab={applicationTab} search={applicationSearch} onTabChange={setApplicationTab} onSearch={setApplicationSearch} onOpen={openDocuments} />}
        {section === 'students' && <Students students={filteredStudents} search={search} onSearch={setSearch} />}
        {section === 'trips' && <Trips trips={trips} />}
        {section === 'sos' && <SosAlerts alerts={sosAlerts} />}
        {section === 'notices' && <Notices announcements={announcements} draft={noticeDraft} setDraft={setNoticeDraft} onCreate={() => { void createNotice(); }} onDelete={(id) => { void deleteNotice(id); }} />}
        {section === 'settings' && <><SettingsView /><div className="admin-content"><PasskeySettings key={profile.id} userId={profile.id} /></div></>}
      </>}
      {selectedApplication && <div className="modal-backdrop" onMouseDown={() => setSelectedApplication(null)}><div className="modal-card admin-review-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setSelectedApplication(null)}><X size={18} /></button><p className="eyebrow center">SOLICITUD DE CONDUCTOR</p><h2>{selectedApplication.applicant?.full_name ?? 'Estudiante sin datos'}</h2><p className="admin-modal-meta">{selectedApplication.applicant?.student_number ?? 'Sin matrícula'} · {selectedApplication.vehicle ? `${selectedApplication.vehicle.brand} ${selectedApplication.vehicle.model}` : 'Vehículo sin datos'} · Placas {selectedApplication.vehicle?.plates ?? '—'}</p><div className="admin-doc-links"><a href={documentLinks.license} target="_blank" rel="noreferrer"><FileCheck2 size={16} /> Abrir licencia <ExternalLink size={13} /></a><a href={documentLinks.registration} target="_blank" rel="noreferrer"><FileCheck2 size={16} /> Abrir tarjeta de circulación <ExternalLink size={13} /></a></div>{selectedApplication.status === 'PENDING_REVIEW' ? <><textarea value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Motivo si rechazas la solicitud" /><div className="admin-review-actions"><button className="primary-button" onClick={() => { void reviewApplication(true); }}><Check size={16} /> Aprobar</button><button className="secondary-button" onClick={() => { void reviewApplication(false); }}><X size={16} /> Rechazar</button></div></> : <p className="admin-muted">{selectedApplication.status === 'APPROVED' ? 'Aprobada' : 'Rechazada'} el {selectedApplication.reviewed_at ? new Date(selectedApplication.reviewed_at).toLocaleString('es-MX') : 'sin fecha registrada'}{selectedApplication.reviewer ? ` por ${selectedApplication.reviewer.full_name}` : ''}{selectedApplication.rejection_reason ? ` · Motivo: ${selectedApplication.rejection_reason}` : ''}.</p>}</div></div>}
    </main>
  </div>;
}

function Overview({ stats, profiles, sosAlerts, onNavigate }: { stats: { students: number; drivers: number; administrators: number; verified: number; pending: number; activeTrips: number; activeSos: number }; profiles: StudentRow[]; sosAlerts: SosRow[]; onNavigate: (section: AdminSection) => void }) {
  return <div className="admin-content"><div className="admin-welcome"><div><p className="eyebrow">VISTA OPERATIVA</p><h2>Todo Student Go, en un solo lugar.</h2><p>Supervisa la comunidad, los viajes y la seguridad desde una experiencia exclusiva para administradores.</p></div><div className="admin-welcome-icon"><LayoutDashboard size={30} /></div></div><div className="admin-stat-grid"><StatCard icon={GraduationCap} label="Estudiantes" value={stats.students} detail={`${stats.verified} con UTP verificada`} tone="blue" onClick={() => onNavigate('students')} /><StatCard icon={CarFront} label="Conductores" value={stats.drivers} detail="Rol adicional aprobado" tone="green" /><StatCard icon={ShieldCheck} label="Administradores" value={stats.administrators} detail="Cuentas con acceso total" tone="orange" /><StatCard icon={Siren} label="SOS activos" value={stats.activeSos} detail="Requieren seguimiento" tone="red" onClick={() => onNavigate('sos')} /></div><div className="admin-overview-grid"><section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-kicker">OPERACIÓN</span><h3>Solicitudes y viajes</h3></div><button className="ghost-button" onClick={() => onNavigate('applications')}>Revisar solicitudes <ExternalLink size={13} /></button></div><div className="admin-role-summary"><div><strong>{stats.pending}</strong><span>Solicitudes pendientes</span></div><div><strong>{stats.activeTrips}</strong><span>Viajes activos</span></div><div><strong>{profiles.filter((profile) => profile.student_verified).length}</strong><span>UTP verificadas</span></div></div></section><section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-kicker">SEGURIDAD</span><h3>Últimos incidentes</h3></div><button className="ghost-button" onClick={() => onNavigate('sos')}>Abrir seguimiento</button></div>{sosAlerts.slice(0, 3).map((alert) => <div className="admin-activity" key={alert.id}><div className={`admin-activity-icon ${alert.status === 'RESOLVED' ? 'safe' : 'danger'}`}><Siren size={15} /></div><div><strong>{alert.status === 'RESOLVED' ? 'Incidente resuelto' : 'Incidente activo'}</strong><span>{alert.message || 'Sin mensaje adicional'} · {new Date(alert.created_at).toLocaleString('es-MX')}</span></div></div>)}{sosAlerts.length === 0 && <p className="admin-muted">No hay incidentes registrados.</p>}</section></div></div>;
}

function StatCard({ icon: Icon, label, value, detail, tone, onClick }: { icon: typeof Users; label: string; value: number; detail: string; tone: string; onClick?: () => void }) {
  return <button className={`admin-stat-card ${tone}`} onClick={onClick}><div className="admin-stat-icon"><Icon size={19} /></div><span>{label}</span><strong>{value}</strong><small>{detail}</small></button>;
}

function Applications({ applications, counts, activeTab, search, onTabChange, onSearch, onOpen }: { applications: ApplicationRow[]; counts: Record<ApplicationTab, number>; activeTab: ApplicationTab; search: string; onTabChange: (tab: ApplicationTab) => void; onSearch: (value: string) => void; onOpen: (application: ApplicationRow) => void }) {
  const labels: Record<ApplicationTab, string> = { PENDING_REVIEW: 'Pendientes', APPROVED: 'Aprobadas', REJECTED: 'Rechazadas' };
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">CONTROL DOCUMENTAL</p><h2>Solicitudes de conductores</h2><p>Consulta el historial completo y revisa los documentos privados enviados.</p></div><span className="admin-count-badge">{counts[activeTab]} {labels[activeTab].toLowerCase()}</span></div><div className="admin-tabs">{(Object.keys(labels) as ApplicationTab[]).map((tab) => <button key={tab} className={activeTab === tab ? 'active' : ''} onClick={() => onTabChange(tab)}>{labels[tab]} <b>{counts[tab]}</b></button>)}</div><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar estudiante, matrícula, vehículo o placas" /></label><div className="admin-list">{applications.map((application) => <article className="admin-list-card" key={application.id}><div className={`admin-list-icon ${application.status === 'APPROVED' ? 'green' : application.status === 'REJECTED' ? 'red' : 'orange'}`}><CarFront size={20} /></div><div className="admin-list-copy"><strong>{application.applicant?.full_name ?? 'Estudiante sin datos'}</strong><span>{application.applicant?.student_number ?? 'Sin matrícula'} · {application.vehicle ? `${application.vehicle.brand} ${application.vehicle.model}` : 'Vehículo sin datos'} · {application.vehicle?.plates ?? 'Sin placas'}</span><small>Solicitud: {application.submitted_at ? new Date(application.submitted_at).toLocaleString('es-MX') : 'Fecha no disponible'}{application.reviewed_at ? ` · Resolución: ${new Date(application.reviewed_at).toLocaleString('es-MX')}` : ''}{application.reviewer ? ` · ${application.reviewer.full_name}` : ''}</small></div><span className={`admin-status ${application.status.toLowerCase()}`}>{labels[application.status as ApplicationTab]}</span><button className="small-button" onClick={() => onOpen(application)}>Ver documentos</button></article>)}{applications.length === 0 && <EmptyState icon={ClipboardCheck} title={`No hay solicitudes ${labels[activeTab].toLowerCase()}`} text="Prueba con otra búsqueda o cambia de pestaña." />}</div></div>;
}

function Students({ students, search, onSearch }: { students: StudentRow[]; search: string; onSearch: (value: string) => void }) {
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">COMUNIDAD</p><h2>Estudiantes</h2><p>Solo se muestran perfiles con rol funcional STUDENT.</p></div><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar estudiante" /></label></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Estudiante</th><th>Matrícula</th><th>Verificación UTP</th><th>Conductor</th></tr></thead><tbody>{students.map((student) => <tr key={student.id}><td><strong>{student.full_name}</strong><span>{student.email}</span></td><td>{student.student_number}</td><td>{student.student_verified ? <span className="admin-verified"><Check size={14} /> Verificada</span> : <span className="admin-pending"><Clock3 size={14} /> Pendiente</span>}</td><td>{student.driver_verified ? <span className="admin-verified"><Check size={14} /> Aprobado</span> : <span className="admin-muted">No aprobado</span>}</td></tr>)}</tbody></table>{students.length === 0 && <EmptyState icon={GraduationCap} title="No encontramos estudiantes" text="Prueba con otro nombre, correo o matrícula." />}</div></div>;
}

function Trips({ trips }: { trips: TripRow[] }) {
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">MOVILIDAD</p><h2>Viajes</h2><p>Supervisa recorridos y estados operativos.</p></div><span className="admin-count-badge">{trips.length} registrados</span></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Ruta</th><th>Salida</th><th>Vehículo</th><th>Estado</th></tr></thead><tbody>{trips.map((trip) => <tr key={trip.id}><td><strong>{trip.origin_text}</strong><span>→ {trip.destination_text}</span></td><td>{new Date(trip.departure_at).toLocaleString('es-MX')}</td><td>{trip.vehicle_name}</td><td><span className={`admin-status ${trip.status.toLowerCase()}`}>{trip.status}</span></td></tr>)}</tbody></table>{trips.length === 0 && <EmptyState icon={Route} title="Aún no hay viajes" text="Los recorridos publicados aparecerán aquí." />}</div></div>;
}

function SosAlerts({ alerts }: { alerts: SosRow[] }) {
  const [selected, setSelected] = useState<SosRow | null>(null);
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">CENTRO DE SEGURIDAD</p><h2>Incidentes SOS</h2><p>Seguimiento de emergencias y cronología de cada alerta.</p></div><span className="admin-count-badge danger-badge">{alerts.filter((alert) => alert.status !== 'RESOLVED').length} activos</span></div><div className="admin-list">{alerts.map((alert) => <article className="admin-list-card clickable" key={alert.id} role="button" tabIndex={0} onClick={() => setSelected(alert)} onKeyDown={(event) => { if (event.key === 'Enter') setSelected(alert); }}><div className={`admin-list-icon ${alert.status === 'RESOLVED' ? 'green' : 'red'}`}><Siren size={20} /></div><div className="admin-list-copy"><strong>{alert.status === 'RESOLVED' ? 'Incidente resuelto' : 'Atención requerida'} · {alert.role}</strong><span>{alert.message || 'Sin mensaje adicional'}</span><small>{new Date(alert.created_at).toLocaleString('es-MX')}{alert.resolved_at ? ` · Resuelto ${new Date(alert.resolved_at).toLocaleString('es-MX')}` : ''}</small></div><span className={`admin-status ${alert.status.toLowerCase()}`}>{alert.status}</span></article>)}{alerts.length === 0 && <EmptyState icon={ShieldCheck} title="Sin incidentes SOS" text="No hay emergencias registradas." />}</div>{selected && <SosIncidentDetail alert={selected} onClose={() => setSelected(null)} />}</div>;
}

function Notices({ announcements, draft, setDraft, onCreate, onDelete }: { announcements: Announcement[]; draft: { title: string; message: string; type: string }; setDraft: (draft: { title: string; message: string; type: string }) => void; onCreate: () => void; onDelete: (id: string) => void }) {
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">COMUNICACIÓN</p><h2>Avisos administrativos</h2><p>Publica información operativa para la comunidad Student Go.</p></div></div><div className="admin-notice-grid"><section className="admin-panel admin-notice-form"><h3>Nuevo aviso</h3><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Título del aviso" /><select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}><option value="GENERAL">General</option><option value="SAFETY">Seguridad</option><option value="MAINTENANCE">Mantenimiento</option></select><textarea value={draft.message} onChange={(event) => setDraft({ ...draft, message: event.target.value })} placeholder="Escribe el mensaje para la comunidad" /><button className="primary-button" onClick={onCreate}><Megaphone size={16} /> Publicar aviso</button></section><section className="admin-list">{announcements.map((announcement) => <article className="admin-notice-card" key={announcement.id}><div><span className="admin-kicker">{announcement.type}</span><h3>{announcement.title}</h3><p>{announcement.message}</p><small>{new Date(announcement.created_at).toLocaleString('es-MX')}</small></div><button onClick={() => onDelete(announcement.id)} aria-label="Eliminar aviso"><X size={16} /></button></article>)}{announcements.length === 0 && <EmptyState icon={Bell} title="No hay avisos publicados" text="Crea el primer aviso administrativo." />}</section></div></div>;
}

function SettingsView() {
  return <div className="admin-content"><div className="admin-section-intro"><div><p className="eyebrow">CONTROL DEL SISTEMA</p><h2>Configuración e integraciones</h2><p>Estado operativo de StudentGo y del protocolo de acompañamiento.</p></div></div><div className="admin-settings-grid"><section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-kicker">ACOMPAÑAMIENTO INTELIGENTE</span><h3>Protocolo de seguridad</h3></div><Settings size={19} /></div><div className="admin-config-list"><span>Contactos por estudiante <strong>2 requeridos</strong></span><span>Enlaces de seguimiento <strong>Privados y temporales</strong></span><span>Recordatorio de llegada <strong>10 minutos</strong></span><span>Incidentes <strong>Visibles para ADMIN</strong></span></div></section><section className="admin-panel"><div className="admin-panel-heading"><div><span className="admin-kicker">INTEGRACIONES</span><h3>Estado operativo</h3></div><ShieldCheck size={19} /></div><div className="admin-integration"><Check size={15} /><div><strong>Supabase Auth y RLS</strong><span>Roles y datos protegidos</span></div></div><div className="admin-integration"><Check size={15} /><div><strong>WhatsApp Business</strong><span>Cola y registro de mensajes preparados</span></div></div><div className="admin-integration"><Check size={15} /><div><strong>Documentos de conductor</strong><span>Almacenamiento privado con enlaces temporales</span></div></div></section></div></div>;
}

function EmptyState({ icon: Icon, title, text }: { icon: typeof ClipboardCheck; title: string; text: string }) {
  return <div className="empty-panel admin-empty"><Icon size={24} /><h3>{title}</h3><p>{text}</p></div>;
}
