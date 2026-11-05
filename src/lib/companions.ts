import { supabase } from '@/lib/supabase';

export type CompanionSource = 'COMPANION' | 'EMERGENCY_CONTACT';
export type CompanionSelection = 'EMERGENCY_CONTACTS' | 'WAITING_PERSON' | 'BOTH' | 'NOW_NOT';
export type CompanionInput = { name: string; relationship: string; phone: string; source: CompanionSource; locationConsent: boolean; whatsappConsent: boolean };
export type CompanionRow = {
  id: string;
  trip_request_id: string;
  name: string;
  relationship: string;
  phone: string;
  source: CompanionSource;
  expires_at: string;
  revoked_at: string | null;
  closed_at: string | null;
  delivery_status: string;
  arrival_response: string | null;
  reminder_attempts: number;
};
export type ArrivalResponse = 'ARRIVED' | 'NOT_ARRIVED' | 'CANNOT_CONFIRM';

type RpcResult = { ok: boolean; reason: string; token?: string; companion_id?: string; sos_alert_id?: string | null; active?: boolean };

export type TrackingView = {
  studentFirstName: string;
  companionName: string;
  origin: string;
  destination: string;
  departureAt: string;
  tripStatus: string;
  tripStarted: boolean;
  tripCompleted: boolean;
  studentConfirmedAt: string | null;
  companionResponse: ArrivalResponse | null;
  latitude: number | null;
  longitude: number | null;
  locationAt: string | null;
  expiresAt: string;
};
export type TrackingResult = { ok: true; view: TrackingView } | { ok: false; reason: string };

const REASON_MESSAGES: Record<string, string> = {
  NO_AUTENTICADO: 'Inicia sesión para activar el acompañamiento.',
  CONSENTIMIENTO_REQUERIDO: 'Debes autorizar compartir tu ubicación.',
  CONSENTIMIENTO_WHATSAPP_REQUERIDO: 'Confirma la autorización de WhatsApp para este destinatario.',
  CONTACTO_WHATSAPP_NO_AUTORIZADO: 'Este número no tiene autorización vigente para recibir WhatsApp.',
  NOMBRE_INVALIDO: 'Escribe un nombre de 2 a 80 caracteres.',
  RELACION_INVALIDA: 'Escribe la relación con la persona.',
  TELEFONO_INVALIDO: 'Escribe un número de teléfono válido.',
  SOLICITUD_NO_ENCONTRADA: 'No encontramos tu lugar en este viaje.',
  VIAJE_NO_EN_CURSO: 'El acompañamiento se activa cuando inicia el recorrido.',
  LIMITE_ALCANZADO: 'Este viaje ya tiene el máximo de enlaces activos.',
  ENLACE_NO_VALIDO: 'Este enlace no es válido.',
  ENLACE_REVOCADO: 'El estudiante revocó este enlace.',
  ENLACE_EXPIRADO: 'Este enlace expiró.',
  ACOMPANAMIENTO_FINALIZADO: 'El acompañamiento ya finalizó.',
  ACOMPAÑAMIENTO_NO_ACTIVADO: 'Primero elige activar Acompañamiento Inteligente para este viaje.',
  VIAJE_EN_CURSO: 'El viaje todavía no ha terminado.',
  RESPUESTA_INVALIDA: 'La respuesta no es válida.',
};

export function reasonMessage(reason: string): string {
  return REASON_MESSAGES[reason] ?? 'No pudimos completar la acción. Intenta de nuevo.';
}

function isRpcResult(value: unknown): value is RpcResult {
  return typeof value === 'object' && value !== null && typeof (value as RpcResult).ok === 'boolean' && typeof (value as RpcResult).reason === 'string';
}

export async function createCompanion(tripRequestId: string, input: CompanionInput): Promise<{ ok: true; link: string; token: string; companionId: string } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc('create_ride_companion', {
    p_trip_request_id: tripRequestId, p_name: input.name, p_relationship: input.relationship,
    p_phone: input.phone, p_source: input.source, p_consent: input.locationConsent, p_whatsapp_consent: input.whatsappConsent,
  });
  if (error || !isRpcResult(data)) return { ok: false, message: 'No pudimos crear el enlace. Intenta de nuevo.' };
  if (!data.ok || !data.token || !data.companion_id) return { ok: false, message: reasonMessage(data.reason) };
  return { ok: true, token: data.token, companionId: data.companion_id, link: `${window.location.origin}/seguimiento/${data.token}` };
}

export async function listCompanions(tripRequestId: string): Promise<CompanionRow[] | null> {
  const { data, error } = await supabase.from('ride_companions')
    .select('id, trip_request_id, name, relationship, phone, source, expires_at, revoked_at, closed_at, delivery_status, arrival_response, reminder_attempts')
    .eq('trip_request_id', tripRequestId).order('created_at');
  if (error) return null;
  return (data ?? []) as CompanionRow[];
}

export async function revokeCompanion(companionId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('revoke_ride_companion', { p_companion_id: companionId });
  return !error && isRpcResult(data) && data.ok;
}

export async function setCompanionshipPreference(tripId: string, selection: CompanionSelection, locationConsent: boolean): Promise<{ ok: true; active: boolean } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc('set_trip_companionship_preference', {
    p_trip_id: tripId, p_selection: selection, p_location_consent: locationConsent,
  });
  if (error || !isRpcResult(data)) return { ok: false, message: 'No pudimos guardar tu decisión de acompañamiento.' };
  if (!data.ok) return { ok: false, message: reasonMessage(data.reason) };
  return { ok: true, active: data.active === true };
}

export async function fetchTracking(token: string): Promise<TrackingResult | null> {
  const { data, error } = await supabase.rpc('get_companion_tracking', { p_token: token });
  if (error || typeof data !== 'object' || data === null) return null;
  const raw = data as Record<string, unknown>;
  if (raw.ok !== true) return { ok: false, reason: typeof raw.reason === 'string' ? raw.reason : 'ENLACE_NO_VALIDO' };
  return {
    ok: true,
    view: {
      studentFirstName: String(raw.student_first_name ?? 'Estudiante'),
      companionName: String(raw.companion_name ?? ''),
      origin: String(raw.origin ?? ''),
      destination: String(raw.destination ?? ''),
      departureAt: String(raw.departure_at ?? ''),
      tripStatus: String(raw.trip_status ?? ''),
      tripStarted: raw.trip_started === true,
      tripCompleted: raw.trip_completed === true,
      studentConfirmedAt: typeof raw.student_confirmed_at === 'string' ? raw.student_confirmed_at : null,
      companionResponse: (raw.companion_response as ArrivalResponse | null) ?? null,
      latitude: typeof raw.latitude === 'number' ? raw.latitude : null,
      longitude: typeof raw.longitude === 'number' ? raw.longitude : null,
      locationAt: typeof raw.location_at === 'string' ? raw.location_at : null,
      expiresAt: String(raw.expires_at ?? ''),
    },
  };
}

export async function respondArrival(token: string, response: ArrivalResponse): Promise<{ ok: true; sosAlertId: string | null } | { ok: false; message: string }> {
  const { data, error } = await supabase.rpc('respond_companion_arrival', { p_token: token, p_response: response });
  if (error || !isRpcResult(data)) return { ok: false, message: 'No pudimos registrar tu respuesta. Intenta de nuevo.' };
  if (!data.ok) return { ok: false, message: reasonMessage(data.reason) };
  return { ok: true, sosAlertId: data.sos_alert_id ?? null };
}
