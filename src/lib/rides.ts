import { supabase } from '@/lib/supabase';

export type RequestStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
export type RideTripStatus = 'PUBLISHED' | 'FULL' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export type RideTrip = {
  id: string;
  driverId: string;
  origin: string;
  destination: string;
  departureAt: string;
  status: RideTripStatus;
  vehicle: string;
  plates: string;
  suggestedFare: number;
  meetingPointReachedAt: string | null;
};

export type RideRequest = {
  id: string;
  tripId: string;
  passengerId: string;
  status: RequestStatus;
  fare: number;
  requestedAt: string;
  passengerConfirmedAt: string | null;
  tripStartedAt: string | null;
  tripCompletedAt: string | null;
};

export type DriverRequest = RideRequest & { passengerName: string };
export type PassengerRide = { request: RideRequest; trip: RideTrip };
export type DriverTripGroup = { trip: RideTrip; requests: DriverRequest[] };

type TripRow = {
  id: string;
  driver_id: string;
  origin_text: string;
  destination_text: string;
  departure_at: string;
  suggested_fare: number | string | null;
  vehicle_name: string | null;
  vehicle_plates: string | null;
  status: RideTripStatus;
  meeting_point_reached_at: string | null;
};

type RequestRow = {
  id: string;
  trip_id: string;
  passenger_id: string;
  status: RequestStatus;
  fare: number | string | null;
  requested_at: string;
  passenger_confirmed_at: string | null;
  trip_started_at: string | null;
  trip_completed_at: string | null;
};

const TRIP_SELECT = 'id, driver_id, origin_text, destination_text, departure_at, suggested_fare, vehicle_name, vehicle_plates, status, meeting_point_reached_at';
const REQUEST_SELECT = 'id, trip_id, passenger_id, status, fare, requested_at, passenger_confirmed_at, trip_started_at, trip_completed_at';

function toTrip(row: TripRow): RideTrip {
  return {
    id: row.id, driverId: row.driver_id, origin: row.origin_text, destination: row.destination_text,
    departureAt: row.departure_at, status: row.status, vehicle: row.vehicle_name ?? '', plates: row.vehicle_plates ?? '',
    suggestedFare: Number(row.suggested_fare ?? 0), meetingPointReachedAt: row.meeting_point_reached_at,
  };
}

function toRequest(row: RequestRow): RideRequest {
  return {
    id: row.id, tripId: row.trip_id, passengerId: row.passenger_id, status: row.status, fare: Number(row.fare ?? 0),
    requestedAt: row.requested_at, passengerConfirmedAt: row.passenger_confirmed_at,
    tripStartedAt: row.trip_started_at, tripCompletedAt: row.trip_completed_at,
  };
}

function unavailableTrip(tripId: string, departureAt: string): RideTrip {
  return {
    id: tripId, driverId: '', origin: 'Viaje no disponible', destination: '', departureAt, status: 'CANCELLED',
    vehicle: '', plates: '', suggestedFare: 0, meetingPointReachedAt: null,
  };
}

export async function fetchPassengerRides(userId: string): Promise<PassengerRide[] | null> {
  const { data: requestRows, error: requestError } = await supabase.from('trip_requests').select(REQUEST_SELECT).eq('passenger_id', userId).order('requested_at', { ascending: false });
  if (requestError) return null;
  const requests = (requestRows ?? []) as RequestRow[];
  if (!requests.length) return [];
  const tripIds = [...new Set(requests.map((row) => row.trip_id))];
  const { data: tripRows, error: tripError } = await supabase.from('trips').select(TRIP_SELECT).in('id', tripIds);
  if (tripError) return null;
  const trips = new Map(((tripRows ?? []) as TripRow[]).map((row) => [row.id, toTrip(row)]));
  return requests.map((row) => ({
    request: toRequest(row),
    trip: trips.get(row.trip_id) ?? unavailableTrip(row.trip_id, row.requested_at),
  }));
}

export async function fetchDriverTrips(userId: string): Promise<DriverTripGroup[] | null> {
  const { data: tripRows, error: tripError } = await supabase.from('trips').select(TRIP_SELECT).eq('driver_id', userId).order('departure_at', { ascending: false });
  if (tripError) return null;
  const trips = ((tripRows ?? []) as TripRow[]).map(toTrip);
  if (!trips.length) return [];
  const { data: requestRows, error: requestError } = await supabase.from('trip_requests').select(REQUEST_SELECT).in('trip_id', trips.map((trip) => trip.id)).order('requested_at');
  if (requestError) return null;
  const requests = (requestRows ?? []) as RequestRow[];
  const passengerIds = [...new Set(requests.map((row) => row.passenger_id))];
  const names = new Map<string, string>();
  if (passengerIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', passengerIds);
    (profiles ?? []).forEach((profile) => { names.set(String(profile.id), profile.full_name ?? 'Estudiante'); });
  }
  return trips.map((trip) => ({
    trip,
    requests: requests
      .filter((row) => row.trip_id === trip.id)
      .map((row) => ({ ...toRequest(row), passengerName: names.get(row.passenger_id) ?? 'Estudiante' })),
  }));
}

export function isFinishedTrip(status: RideTripStatus): boolean {
  return status === 'COMPLETED' || status === 'CANCELLED';
}

export const REQUEST_LABEL: Record<RequestStatus, string> = { PENDING: 'Pendiente', ACCEPTED: 'Aceptada', REJECTED: 'Rechazada', CANCELLED: 'Cancelada' };
export const REQUEST_PILL: Record<RequestStatus, string> = { PENDING: 'pending', ACCEPTED: 'confirmed', REJECTED: 'rejected', CANCELLED: 'cancelled' };

export function passengerOutcome(ride: PassengerRide): { label: string; pill: string } {
  if (ride.trip.status === 'CANCELLED') return { label: 'Viaje cancelado', pill: 'cancelled' };
  if (ride.request.status === 'ACCEPTED' && ride.trip.status === 'COMPLETED') return { label: 'Completado', pill: 'confirmed' };
  if (ride.request.status === 'PENDING') return { label: 'Sin respuesta', pill: 'pending' };
  return { label: REQUEST_LABEL[ride.request.status], pill: REQUEST_PILL[ride.request.status] };
}

export function driverOutcome(trip: RideTrip): { label: string; pill: string } {
  return trip.status === 'COMPLETED' ? { label: 'Completado', pill: 'confirmed' } : { label: 'Cancelado', pill: 'cancelled' };
}

export function formatRideDate(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
}
