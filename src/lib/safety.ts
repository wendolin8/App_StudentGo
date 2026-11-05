export type SosRole = 'STUDENT' | 'DRIVER';
export type SosStatus = 'ACTIVE' | 'VERIFYING' | 'RESOLVED';

export type SosIncident = {
  id: string;
  trip_id: string | null;
  role: SosRole;
  status: SosStatus;
  latitude: number | null;
  longitude: number | null;
  message: string | null;
  auto_triggered: boolean;
  created_at: string;
  verification_started_at: string | null;
  resolved_at: string | null;
  verified_by: string | null;
  resolution_method: string | null;
  resolution_note: string | null;
};

export type NotificationItem = {
  id: string;
  title: string;
  message: string;
  type: string;
  target: 'trips' | 'security' | null;
  reference_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type ActiveTrip = {
  tripId: string;
  role: SosRole;
  route: string;
  vehicle: string;
  arrivalAt: string | null;
  confirmed: boolean;
};

export const RESOLUTION_METHODS = [
  { value: 'CONFIRMO_EN_APP', label: 'La persona confirmó que está a salvo' },
  { value: 'VERIFICO_LLAMADA', label: 'Verifiqué por llamada con la persona' },
  { value: 'REPORTE_911', label: 'Se reportó al 911' },
  { value: 'FALSA_ALARMA', label: 'Falsa alarma verificada' },
] as const;

export const ARRIVAL_GRACE_MINUTES = 10;

export function getSafetyLevel(trip: ActiveTrip | null, openIncidents: SosIncident[]): { level: 'NONE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED'; label: string } {
  if (openIncidents.some((i) => !i.auto_triggered)) return { level: 'RED', label: 'Emergencia activa' };
  const auto = openIncidents.find((i) => i.auto_triggered);
  if (auto) return auto.latitude == null || auto.longitude == null
    ? { level: 'RED', label: 'Escalado sin ubicación' }
    : { level: 'ORANGE', label: 'SOS automático en verificación' };
  if (!trip) return { level: 'NONE', label: 'Sin viaje en curso' };
  if (trip.arrivalAt && !trip.confirmed) return { level: 'YELLOW', label: 'Esperando confirmación de llegada' };
  return { level: 'GREEN', label: 'Viaje en curso sin incidentes' };
}

export const SAFETY_COLORS: Record<string, string> = {
  NONE: '#9ca3af',
  GREEN: '#31a17c',
  YELLOW: '#c58a30',
  ORANGE: '#ea580c',
  RED: '#dc2626',
};
