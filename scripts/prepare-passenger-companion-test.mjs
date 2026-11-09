import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const lines = readFileSync('.env.pruebas.local', 'utf8').split(/\r?\n/);
const env = Object.fromEntries(lines.filter((line) => line.includes('=')).map((line) => {
  const separator = line.indexOf('=');
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
}));

const ref = env.STUDENT_GO_TEST_PROJECT_REF;
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (ref !== 'evihpbooyvtmxvivewau' || url !== `https://${ref}.supabase.co` || !key) {
  throw new Error('Bloqueado: este guion solo acepta el proyecto aislado student-go-pruebas.');
}

function assert(condition, message) {
  if (!condition) throw new Error(`PRUEBA FALLIDA: ${message}`);
  console.log(`APROBADA: ${message}`);
}

async function signIn(email, password) {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error(`No se pudo iniciar la sesión de prueba ${email}.`);
  return { client, user: data.user, email };
}

const admin = await signIn('studentgo.admin@gmail.com', process.env.STUDENT_GO_ADMIN_PASSWORD_OVERRIDE ?? env.STUDENT_GO_ADMIN_PASSWORD);
const driver = await signIn('studentconductor@gmail.com', process.env.STUDENT_GO_DRIVER_PASSWORD_OVERRIDE ?? env.STUDENT_GO_DRIVER_PASSWORD);
const passenger = await signIn('studentpasajero@gmail.com', process.env.STUDENT_GO_PASSENGER_PASSWORD_OVERRIDE ?? env.STUDENT_GO_PASSENGER_PASSWORD);

const [{ data: adminProfile }, { data: driverProfile }, { data: passengerProfile }] = await Promise.all([
  admin.client.from('profiles').select('role').eq('id', admin.user.id).single(),
  driver.client.from('profiles').select('role, driver_verified').eq('id', driver.user.id).single(),
  passenger.client.from('profiles').select('role').eq('id', passenger.user.id).single(),
]);
assert(adminProfile?.role === 'ADMIN', 'la cuenta ADMIN conserva su rol');
assert(driverProfile?.role === 'DRIVER' && driverProfile.driver_verified === true, 'el conductor está aprobado');
assert(passengerProfile?.role === 'STUDENT', 'el pasajero conserva su rol STUDENT');

const { data: vehicle, error: vehicleError } = await driver.client.from('vehicles')
  .select('id, passenger_capacity').eq('owner_id', driver.user.id).eq('status', 'APPROVED').limit(1).maybeSingle();
if (vehicleError || !vehicle) throw new Error('No hay vehículo aprobado para el conductor de prueba.');

const run = randomUUID().slice(0, 8).toUpperCase();
const { data: tripId, error: publishError } = await driver.client.rpc('publish_trip_with_vehicle', {
  p_vehicle_id: vehicle.id,
  p_origin_text: `PRUEBA GPS PASAJERO ${run} - UTP`,
  p_destination_text: `PRUEBA GPS PASAJERO ${run} - Destino seguro`,
  p_origin_lat: 19.0497, p_origin_lng: -98.2195, p_destination_lat: 19.0730, p_destination_lng: -98.2027,
  p_departure_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  p_available_seats: Math.max(1, vehicle.passenger_capacity - 1),
  p_distance_km: 3, p_estimated_minutes: 15, p_suggested_fare: 25,
  p_notes: 'Escenario aislado para GPS físico del pasajero. Sin coordenadas simuladas.',
});
if (publishError || !tripId) throw new Error(`No se publicó el viaje mediante RPC: ${publishError?.message ?? 'sin id'}`);

const { data: visibleTrip, error: visibleError } = await passenger.client.from('trips')
  .select('id, status, suggested_fare').eq('id', tripId).single();
if (visibleError || visibleTrip?.status !== 'PUBLISHED') throw new Error('El pasajero no pudo encontrar el viaje publicado.');
assert(true, 'el pasajero ve el viaje publicado por el conductor mediante RLS');

const { data: submitted, error: requestError } = await passenger.client.functions.invoke('calculate-fare', {
  body: { trip_id: tripId, dropoff_text: 'Parque Puebla', dropoff_lat: 19.0730, dropoff_lng: -98.2027, submit: true },
});
const { data: request, error: requestRowError } = submitted?.request_id
  ? await passenger.client.from('trip_requests').select('id, status').eq('id', submitted.request_id).single()
  : { data: null, error: requestError };
if (!request || requestRowError) throw new Error('No fue posible consultar la solicitud recién creada.');
if (requestError || request?.status !== 'PENDING') throw new Error(`No se creó la solicitud del pasajero: ${requestError?.message ?? ''}`);

const { data: accepted, error: acceptError } = await driver.client.rpc('accept_ride_request', { request_id: request.id });
if (acceptError || !accepted?.[0]?.ok || !accepted[0].qr_token) throw new Error('El conductor no pudo aceptar la solicitud con el procedimiento real.');
assert(true, 'el conductor aceptó la solicitud y generó el QR privado');

const { data: passengerQr, error: qrError } = await passenger.client.rpc('get_my_ride_qr', { p_trip_id: tripId });
if (qrError || passengerQr !== accepted[0].qr_token) throw new Error('El pasajero no pudo recuperar su QR propio.');
const { data: validation, error: validationError } = await driver.client.rpc('validate_ride_qr', { token_input: passengerQr });
if (validationError || validation?.[0]?.valid !== true) throw new Error('La validación real del QR por el conductor falló.');

const { data: startedTrip, error: startedError } = await passenger.client.from('trips').select('status').eq('id', tripId).single();
const { data: boarding, error: boardingError } = await passenger.client.from('trip_requests').select('qr_used_at, trip_started_at').eq('id', request.id).single();
if (startedError || boardingError || startedTrip?.status !== 'IN_PROGRESS' || !boarding?.qr_used_at || !boarding.trip_started_at) {
  throw new Error('El QR no dejó el viaje EN CURSO con el abordaje registrado.');
}
assert(true, 'QR validado y viaje real de prueba guardado EN_CURSO');

const { data: driverContacts, error: crossReadError } = await driver.client.from('emergency_contacts').select('id').eq('user_id', passenger.user.id);
if (crossReadError || (driverContacts ?? []).length !== 0) throw new Error('El conductor pudo consultar contactos privados del pasajero.');
assert(true, 'RLS bloquea al conductor los contactos privados del pasajero');

const { data: nowNot, error: nowNotError } = await passenger.client.rpc('set_trip_companionship_preference', {
  p_trip_id: tripId, p_selection: 'NOW_NOT', p_location_consent: false,
});
if (nowNotError || !nowNot?.ok || nowNot.active !== false) throw new Error('No se pudo registrar la decisión Ahora no.');
assert(true, 'Ahora no se guarda por pasajero y viaje sin crear enlaces');

const { data: preference, error: preferenceError } = await passenger.client.rpc('set_trip_companionship_preference', {
  p_trip_id: tripId, p_selection: 'WAITING_PERSON', p_location_consent: true,
});
if (preferenceError || !preference?.ok || preference.active !== true) throw new Error('No se pudo reactivar el consentimiento del pasajero.');
const { data: preferenceCheck, error: preferenceCheckError } = await passenger.client.from('trip_companionship_preferences')
  .select('active, selection, location_consent_at').eq('trip_id', tripId).eq('user_id', passenger.user.id).single();
if (preferenceCheckError || !preferenceCheck.active || preferenceCheck.selection !== 'WAITING_PERSON' || !preferenceCheck.location_consent_at) {
  throw new Error('El consentimiento reactivado no persistió.');
}
assert(true, 'la reactivación guarda consentimiento explícito, sin enviar WhatsApp');

console.log(`VIAJE_LISTO=${tripId}`);
console.log(`SOLICITUD_LISTA=${request.id}`);
console.log('No se creó ningún enlace ni se invocó whatsapp-send. El siguiente paso debe hacerse desde el celular del pasajero para pedir GPS físico y realizar el único envío autorizado.');
