import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { createClient } from '@supabase/supabase-js';

const configPath = '.env.pruebas.local';
const config = Object.fromEntries(readFileSync(configPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));

const ref = config.STUDENT_GO_TEST_PROJECT_REF;
const url = config.VITE_SUPABASE_URL;
const publicKey = config.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!ref || ref === 'woigbfrfkjwzcwljyxbi' || url !== `https://${ref}.supabase.co` || !publicKey) {
  throw new Error('Bloqueado: esta prueba solo puede ejecutarse contra student-go-pruebas.');
}

const credentials = [
  { email: 'studentgo.admin@gmail.com', password: config.STUDENT_GO_ADMIN_PASSWORD, role: 'ADMIN' },
  { email: 'studentconductor@gmail.com', password: config.STUDENT_GO_DRIVER_PASSWORD, role: 'STUDENT' },
  { email: 'studentpasajero@gmail.com', password: config.STUDENT_GO_PASSENGER_PASSWORD, role: 'STUDENT' },
];
if (credentials.some((item) => !item.password)) throw new Error('Faltan contraseñas locales de las cuentas de prueba.');

function clientFor(user) {
  const client = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client.auth.signInWithPassword({ email: user.email, password: user.password }).then(({ data, error }) => {
    if (error || !data.user || !data.session) throw new Error(`Falló el inicio de sesión de ${user.email}: ${error?.message ?? 'sin sesión'}`);
    return { client, user: data.user, accessToken: data.session.access_token };
  });
}

function assert(condition, label) {
  if (!condition) throw new Error(`PRUEBA FALLIDA: ${label}`);
  console.log(`APROBADA: ${label}`);
}

function setLocalValue(key, value) {
  const lines = readFileSync(configPath, 'utf8').split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(configPath, `${lines.filter((line) => line.length > 0).join('\n')}\n`, { mode: 0o600 });
  config[key] = value;
}

function minimalTestPdf(label) {
  const stream = `BT /F1 13 Tf 24 55 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 110] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function callShareFunction(session, companionId, token) {
  const response = await fetch(`${url}/functions/v1/whatsapp-send`, {
    method: 'POST',
    headers: { apikey: publicKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'SHARE_LINK', companionId, token }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function invokeSosWhatsApp(session, alertId) {
  const response = await fetch(`${url}/functions/v1/whatsapp-send`, {
    method: 'POST',
    headers: { apikey: publicKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'SOS_ALERT', sosAlertId: alertId }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function ensureApprovedDriver(driver, admin) {
  const { data: currentApps, error: appsError } = await driver.client.from('driver_applications')
    .select('id, status').eq('user_id', driver.user.id).order('created_at', { ascending: false }).limit(1);
  if (appsError) throw new Error(`No se pudo consultar la solicitud del conductor: ${appsError.message}`);
  let appId = currentApps?.[0]?.id;
  let status = currentApps?.[0]?.status;
  let vehicle;

  if (status === 'APPROVED') {
    const { data, error } = await driver.client.from('vehicles').select('id, status, brand, model, plates, passenger_capacity')
      .eq('owner_id', driver.user.id).eq('status', 'APPROVED').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(`No se pudo consultar el vehículo aprobado: ${error.message}`);
    vehicle = data;
  }

  if (!vehicle) {
    const suffix = randomBytes(2).toString('hex').toUpperCase();
    const licensePath = `${driver.user.id}/PRUEBA-LICENCIA-${suffix}.pdf`;
    const cardPath = `${driver.user.id}/PRUEBA-TARJETA-${suffix}.pdf`;
    const pdfOptions = { contentType: 'application/pdf', upsert: false };
    const [license, card] = await Promise.all([
      driver.client.storage.from('student-documents').upload(licensePath, minimalTestPdf('DOCUMENTO FICTICIO DE PRUEBA - NO VALIDO'), pdfOptions),
      driver.client.storage.from('student-documents').upload(cardPath, minimalTestPdf('TARJETA FICTICIA DE PRUEBA - NO VALIDA'), pdfOptions),
    ]);
    if (license.error || card.error) throw new Error(`No se pudieron guardar documentos PDF ficticios: ${license.error?.message ?? card.error?.message}`);
    const { data: submitted, error: submitError } = await driver.client.rpc('submit_driver_application', {
      p_brand: 'Vehículo de prueba', p_model: 'Modelo ficticio', p_year: new Date().getFullYear(),
      p_color: 'Azul prueba', p_plates: `TST-${suffix}`, p_capacity: 3,
      p_license_path: licensePath, p_registration_card_path: cardPath,
      p_license_expires_at: '2099-12-31', p_registration_expires_at: '2099-12-31',
    });
    if (submitError || !submitted?.[0]?.ok) throw new Error(`submit_driver_application falló: ${submitError?.message ?? submitted?.[0]?.reason}`);
    appId = submitted[0].application_id;
    status = 'PENDING_REVIEW';
    console.log('APROBADA: solicitud y vehículo de prueba enviados por Storage y RPC autenticados; documentos marcados como ficticios.');
  }

  if (status !== 'APPROVED') {
    const { data, error } = await admin.client.rpc('review_driver_application', { p_application_id: appId, p_approved: true, p_reason: null });
    if (error || !data?.[0]?.ok) throw new Error(`La revisión ADMIN falló: ${error?.message ?? data?.[0]?.reason}`);
  }
  const { data: approvedProfile, error: profileError } = await driver.client.from('profiles')
    .select('role, student_verified, driver_verified').eq('id', driver.user.id).single();
  if (profileError || approvedProfile.role !== 'DRIVER' || !approvedProfile.driver_verified || approvedProfile.student_verified) {
    throw new Error(`Estado del conductor inesperado: ${profileError?.message ?? JSON.stringify(approvedProfile)}`);
  }
  if (!vehicle) {
    const { data, error } = await driver.client.from('vehicles').select('id, status, brand, model, plates, passenger_capacity')
      .eq('owner_id', driver.user.id).eq('status', 'APPROVED').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error || !data) throw new Error(`El procedimiento ADMIN no aprobó el vehículo: ${error?.message ?? 'sin vehículo aprobado'}`);
    vehicle = data;
  }
  assert(vehicle.status === 'APPROVED' && approvedProfile.student_verified === false, 'Aprobación ADMIN del conductor/vehículo sin marcar UTP como verificada');
  return vehicle;
}

async function enableTestConsent(session) {
  await session.client.rpc('set_whatsapp_alert_consent', { p_enabled: false });
  await session.client.from('emergency_contacts').update({ whatsapp_consent_at: null }).eq('user_id', session.user.id);
  const { data: contacts, error } = await session.client.from('emergency_contacts')
    .select('id, name, relationship, phone, whatsapp_consent_at').eq('user_id', session.user.id).order('created_at');
  if (error || contacts.length !== 2) throw new Error(`Se esperaban exactamente dos contactos ficticios: ${error?.message ?? `actuales=${contacts.length}`}`);
  const { data: rejected, error: rejectError } = await session.client.rpc('set_whatsapp_alert_consent', { p_enabled: true });
  if (rejectError || rejected !== false) throw new Error('El control de consentimiento no rechazó activar WhatsApp sin autorización de los contactos.');
  const now = new Date().toISOString();
  for (const contact of contacts) {
    const { error: consentError } = await session.client.from('emergency_contacts').update({ whatsapp_consent_at: now }).eq('id', contact.id);
    if (consentError) throw new Error(`No se pudo registrar el consentimiento de fixture: ${consentError.message}`);
  }
  const { data: enabled, error: enableError } = await session.client.rpc('set_whatsapp_alert_consent', { p_enabled: true });
  if (enableError || enabled !== true) throw new Error(`No se pudo habilitar consentimiento del fixture de prueba: ${enableError?.message ?? 'RPC devolvió false'}`);
  console.log(`${session.user.email}: consentimiento de prueba temporal para números ficticios; no implica verificación telefónica ni envío real.`);
  return contacts;
}

async function resolveAsAdmin(admin, alertId, label) {
  const { data: started, error: startError } = await admin.client.rpc('start_sos_verification', { alert_uuid: alertId });
  if (startError || !started?.[0]?.ok) throw new Error(`${label}: ADMIN no pudo atender el incidente (${startError?.message ?? started?.[0]?.reason}).`);
  const { data: resolved, error: resolveError } = await admin.client.rpc('resolve_sos', {
    alert_uuid: alertId, p_verified_by: 'ADMIN de prueba', p_method: 'FALSA_ALARMA',
    p_note: 'Ejercicio aislado de desarrollo; se resolvió sin contactar autoridades.',
  });
  if (resolveError || !resolved?.[0]?.ok) throw new Error(`${label}: ADMIN no pudo resolver el incidente (${resolveError?.message ?? resolved?.[0]?.reason}).`);
  const { data: row, error: readError } = await admin.client.from('sos_alerts').select('status, resolved_at').eq('id', alertId).single();
  if (readError || row.status !== 'RESOLVED' || !row.resolved_at) throw new Error(`${label}: la resolución no persistió.`);
  assert(true, `${label}: ADMIN inició verificación y guardó la resolución`);
}

let cleanupSessions = [];
try {
const [admin, driver, passenger] = await Promise.all(credentials.map(clientFor));
cleanupSessions = [driver, passenger];
const profileRows = await Promise.all([admin, driver, passenger].map(async (session) => {
  const { data, error } = await session.client.from('profiles').select('id, role, student_verified, driver_verified').eq('id', session.user.id).single();
  if (error) throw new Error(`No se pudo comprobar el perfil de ${session.user.email}: ${error.message}`);
  return { session, profile: data };
}));
assert(profileRows.find((x) => x.session === admin)?.profile.role === 'ADMIN', 'solo la cuenta admin tiene ADMIN');
assert(['STUDENT', 'DRIVER'].includes(profileRows.find((x) => x.session === driver)?.profile.role) && !profileRows.find((x) => x.session === driver)?.profile.student_verified, 'conductor permanece con UTP no verificada; rol previo conservado');
assert(profileRows.find((x) => x.session === passenger)?.profile.role === 'STUDENT' && !profileRows.find((x) => x.session === passenger)?.profile.student_verified, 'pasajero sigue como estudiante y UTP no verificada');

const { data: driverContacts, error: driverContactsError } = await driver.client.from('emergency_contacts').select('id').eq('user_id', passenger.user.id);
if (driverContactsError) throw new Error(`Consulta cruzada de contactos falló de forma inesperada: ${driverContactsError.message}`);
assert(driverContacts.length === 0, 'RLS impide al conductor leer los contactos del pasajero');

const driverFixtureContacts = await enableTestConsent(driver);
const passengerContacts = await enableTestConsent(passenger);
const vehicle = await ensureApprovedDriver(driver, admin);

const tripRunId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const tripValues = {
  p_vehicle_id: vehicle.id,
  p_origin_text: `ORIGEN FICTICIO DE PRUEBA ${tripRunId}`,
  p_destination_text: `DESTINO FICTICIO DE PRUEBA ${tripRunId}`,
  p_origin_lat: 19.0497, p_origin_lng: -98.2195, p_destination_lat: 19.0730, p_destination_lng: -98.2027,
  p_departure_at: new Date(Date.now() + 60 * 60_000).toISOString(), p_available_seats: 2,
  p_distance_km: 5, p_estimated_minutes: 20, p_suggested_fare: 25, p_notes: 'Datos ficticios aislados; sin coordenadas GPS.',
};
const { data: tripId, error: publishError } = await driver.client.rpc('publish_trip_with_vehicle', tripValues);
if (publishError || !tripId) throw new Error(`publish_trip_with_vehicle falló: ${publishError?.message ?? 'sin trip_id'}`);
const { data: foundTrip, error: searchError } = await passenger.client.from('trips').select('id, status, origin_text, destination_text, available_seats, suggested_fare').eq('id', tripId).single();
if (searchError || foundTrip.status !== 'PUBLISHED') throw new Error(`Búsqueda de pasajero falló: ${searchError?.message ?? 'viaje no visible'}`);
assert(true, 'conductor publica viaje por RPC y pasajero lo encuentra por RLS');

const { data: quote, error: quoteError } = await passenger.client.functions.invoke('calculate-fare', {
  body: { trip_id: tripId, dropoff_text: `DESTINO FICTICIO DE PRUEBA ${tripRunId}`, dropoff_lat: 19.0730, dropoff_lng: -98.2027 },
});
const { data: submittedRequest, error: requestError } = quote?.quote_token
  ? await passenger.client.functions.invoke('request-trip', { body: { quote_token: quote.quote_token } })
  : { data: null, error: quoteError };
const { data: requestRow, error: requestRowError } = submittedRequest?.request_id
  ? await passenger.client.from('trip_requests').select('id, status').eq('id', submittedRequest.request_id).single()
  : { data: null, error: requestError };
if (!requestRow || requestRowError) throw new Error('No fue posible consultar la solicitud recién creada.');
if (requestError || requestRow.status !== 'PENDING') throw new Error(`Solicitud de lugar falló: ${requestError?.message ?? requestRow?.status}`);
const { data: accepted, error: acceptError } = await driver.client.rpc('accept_ride_request', { request_id: requestRow.id });
if (acceptError || !accepted?.[0]?.ok || !accepted[0].qr_token) throw new Error(`Aceptación de viaje falló: ${acceptError?.message ?? accepted?.[0]?.reason}`);
assert(true, 'pasajero solicita lugar y conductor acepta mediante RPC');

const { data: qrToken, error: qrError } = await passenger.client.rpc('get_my_ride_qr', { p_trip_id: tripId });
if (qrError || qrToken !== accepted[0].qr_token) throw new Error(`get_my_ride_qr no devolvió el QR propio: ${qrError?.message ?? 'token distinto'}`);
const qrImage = await QRCode.toDataURL(qrToken);
assert(qrImage.startsWith('data:image/png;base64,') && qrImage.length > 500, 'QR de abordaje generado como imagen PNG');
const { data: foreignQr, error: foreignQrError } = await admin.client.rpc('get_my_ride_qr', { p_trip_id: tripId });
assert(!foreignQrError && foreignQr === null, 'ADMIN no puede recuperar el QR privado del pasajero');
const { data: rawQr, error: rawQrError } = await admin.client.from('trip_requests').select('qr_token').eq('id', requestRow.id);
assert(!!rawQrError || !rawQr?.length, 'RLS/permisos de columna impiden leer QR directamente');

const { data: wrongValidation, error: wrongValidationError } = await admin.client.rpc('validate_ride_qr', { token_input: qrToken });
assert(!wrongValidationError && wrongValidation?.[0]?.valid === false && wrongValidation[0].reason === 'NO_ES_CONDUCTOR', 'validación QR rechaza a usuario distinto del conductor');
const { data: validQr, error: validQrError } = await driver.client.rpc('validate_ride_qr', { token_input: qrToken });
if (validQrError || validQr?.[0]?.valid !== true) throw new Error(`validación QR del conductor falló: ${validQrError?.message ?? validQr?.[0]?.reason}`);
const { data: afterBoarding, error: boardingError } = await driver.client.from('trips').select('status').eq('id', tripId).single();
const { data: requestAfterBoarding, error: requestBoardingError } = await driver.client.from('trip_requests').select('qr_used_at, trip_started_at').eq('id', requestRow.id).single();
if (boardingError || requestBoardingError || afterBoarding.status !== 'IN_PROGRESS' || !requestAfterBoarding.qr_used_at || !requestAfterBoarding.trip_started_at) {
  throw new Error(`El abordaje/estado no persistió: ${boardingError?.message ?? requestBoardingError?.message ?? afterBoarding?.status}`);
}
const { data: replayQr, error: replayError } = await driver.client.rpc('validate_ride_qr', { token_input: qrToken });
assert(!replayError && replayQr?.[0]?.valid === false && replayQr[0].reason === 'QR_YA_USADO', 'QR validado una sola vez; el reuso se rechaza');
assert(true, 'QR validado, abordaje registrado y viaje guardado EN CURSO');

const anonymous = createClient(url, publicKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: blockedCompanion, error: blockedCompanionError } = await passenger.client.rpc('create_ride_companion', {
  p_trip_request_id: requestRow.id, p_name: passengerContacts[0].name, p_relationship: passengerContacts[0].relationship,
  p_phone: passengerContacts[0].phone, p_source: 'EMERGENCY_CONTACT', p_consent: true, p_whatsapp_consent: true,
});
if (blockedCompanionError || blockedCompanion?.ok !== false || blockedCompanion.reason !== 'ACOMPAÑAMIENTO_NO_ACTIVADO') {
  throw new Error(`La creación previa al consentimiento no devolvió el rechazo esperado: ${blockedCompanionError?.message ?? JSON.stringify(blockedCompanion)}`);
}
assert(true, 'QR no autoriza compartir ubicación: se exige elección independiente de acompañamiento');
const { data: passengerPreference, error: passengerPreferenceError } = await passenger.client.rpc('set_trip_companionship_preference', {
  p_trip_id: tripId, p_selection: 'EMERGENCY_CONTACTS', p_location_consent: true,
});
if (passengerPreferenceError || !passengerPreference?.ok || !passengerPreference.active) throw new Error(`No se guardó la preferencia independiente del pasajero: ${passengerPreferenceError?.message ?? passengerPreference?.reason}`);
assert(true, 'pasajero guarda consentimiento independiente por viaje antes de crear enlaces');
const companions = [];
for (const contact of passengerContacts) {
  const { data, error } = await passenger.client.rpc('create_ride_companion', {
    p_trip_request_id: requestRow.id, p_name: contact.name, p_relationship: contact.relationship,
    p_phone: contact.phone, p_source: 'EMERGENCY_CONTACT', p_consent: true, p_whatsapp_consent: true,
  });
  if (error || !data?.ok || !data.token) throw new Error(`No se pudo crear enlace temporal: ${error?.message ?? data?.reason}`);
  companions.push({ id: data.companion_id, token: data.token, contactId: contact.id });
  setLocalValue(`STUDENT_GO_TEST_COMPANION_${companions.length}_TOKEN`, data.token);
  const shareResult = await callShareFunction(passenger, data.companion_id, data.token);
  if (shareResult.status !== 503 || shareResult.body?.status !== 'REQUESTED') {
    throw new Error(`WhatsApp debía quedar REQUESTED sin envío; respuesta HTTP ${shareResult.status}, estado ${shareResult.body?.status ?? 'desconocido'}`);
  }
  const { data: tracking, error: trackingError } = await anonymous.rpc('get_companion_tracking', { p_token: data.token });
  if (trackingError || !tracking?.ok || tracking.trip_status !== 'IN_PROGRESS' || tracking.latitude !== null || tracking.longitude !== null) {
    throw new Error(`Enlace anónimo de seguimiento inválido o ubicación no honesta: ${trackingError?.message ?? tracking?.reason}`);
  }
  const { data: invalidTracking } = await anonymous.rpc('get_companion_tracking', { p_token: 'token-falso-invalido' });
  assert(invalidTracking?.ok === false, 'enlace privado requiere token válido y no usa ubicación ficticia');
}
const { data: hiddenCompanion, error: hiddenCompanionError } = await driver.client.from('ride_companions').select('id').eq('id', companions[0].id);
assert(!hiddenCompanionError && hiddenCompanion.length === 0, 'otro participante no puede consultar la fila del acompañamiento');
console.log('APROBADA: enlaces únicos creados para los dos contactos; WhatsApp quedó REQUESTED, sin proveedor ni envío.');

const { data: driverPreference, error: driverPreferenceError } = await driver.client.rpc('set_trip_companionship_preference', {
  p_trip_id: tripId, p_selection: 'EMERGENCY_CONTACTS', p_location_consent: true,
});
if (driverPreferenceError || !driverPreference?.ok || !driverPreference.active) throw new Error(`No se guardó la preferencia independiente del conductor: ${driverPreferenceError?.message ?? driverPreference?.reason}`);
const { data: driverCompanion, error: driverCompanionError } = await driver.client.rpc('create_ride_companion', {
  p_trip_request_id: requestRow.id, p_name: driverFixtureContacts[0].name, p_relationship: driverFixtureContacts[0].relationship,
  p_phone: driverFixtureContacts[0].phone, p_source: 'EMERGENCY_CONTACT', p_consent: true, p_whatsapp_consent: true,
});
if (driverCompanionError || !driverCompanion?.ok || !driverCompanion.token) throw new Error(`El conductor no pudo crear su enlace independiente: ${driverCompanionError?.message ?? driverCompanion?.reason}`);
const { data: stopDriverPreference, error: stopDriverPreferenceError } = await driver.client.rpc('set_trip_companionship_preference', {
  p_trip_id: tripId, p_selection: 'NOW_NOT', p_location_consent: false,
});
if (stopDriverPreferenceError || !stopDriverPreference?.ok || stopDriverPreference.active) throw new Error(`No se pudo desactivar el acompañamiento del conductor: ${stopDriverPreferenceError?.message ?? stopDriverPreference?.reason}`);
const { data: revokedDriverLink } = await anonymous.rpc('get_companion_tracking', { p_token: driverCompanion.token });
assert(revokedDriverLink?.ok === false && revokedDriverLink.reason === 'ENLACE_REVOCADO', 'conductor puede desactivar su acompañamiento; sus enlaces quedan revocados sin afectar al pasajero');

for (const [label, session] of [['SOS manual conductor', driver], ['SOS manual pasajero', passenger]]) {
  const { data, error } = await session.client.rpc('trigger_sos', { p_lat: null, p_lng: null, p_message: `${label} - prueba aislada` });
  if (error || !data?.[0]?.ok || !data[0].alert_id) throw new Error(`${label} no se registró: ${error?.message ?? data?.[0]?.reason}`);
  const sendResult = await invokeSosWhatsApp(session, data[0].alert_id);
  if (sendResult.status !== 503 || sendResult.body?.status !== 'REQUESTED') {
    throw new Error(`${label}: la cola WhatsApp no quedó en estado seguro: HTTP ${sendResult.status}`);
  }
  const { data: adminNotice } = await admin.client.from('notifications').select('id').eq('user_id', admin.user.id).eq('reference_id', data[0].alert_id).limit(10);
  if (!adminNotice?.length) throw new Error(`${label}: no apareció notificación interna a ADMIN.`);
  await resolveAsAdmin(admin, data[0].alert_id, label);
}

const { data: completed, error: completeError } = await driver.client.rpc('complete_ride', { trip_uuid: tripId });
if (completeError || !completed?.[0]?.ok) throw new Error(`No se pudo completar viaje para las pruebas de llegada: ${completeError?.message ?? completed?.[0]?.reason}`);
const { data: deadlines, error: deadlineError } = await driver.client.from('trip_requests')
  .select('trip_completed_at, arrival_deadline_at, passenger_confirmed_at').eq('id', requestRow.id).single();
if (deadlineError || !deadlines.trip_completed_at || !deadlines.arrival_deadline_at) throw new Error(`No se guardó el plazo de llegada: ${deadlineError?.message ?? 'deadline null'}`);
const deadlineMs = new Date(deadlines.arrival_deadline_at).getTime();
const deltaMs = deadlineMs - new Date(deadlines.trip_completed_at).getTime();
if (Math.abs(deltaMs - 10 * 60_000) > 5000) throw new Error(`Plazo de recordatorio no es de 10 minutos: ${deltaMs}ms`);
assert(true, 'complete_ride guarda arrival_deadline_at a 10 minutos');

const { data: arrivedResponse, error: arrivedError } = await anonymous.rpc('respond_companion_arrival', { p_token: companions[0].token, p_response: 'ARRIVED' });
if (arrivedError || !arrivedResponse?.ok) throw new Error(`Respuesta externa ARRIVED falló: ${arrivedError?.message ?? arrivedResponse?.reason}`);
assert(true, 'acompañante confirma llegada de forma independiente sin iniciar sesión');

console.log(`VIAJE_DE_PRUEBA=${tripId}`);
console.log(`SOLICITUD_DE_PRUEBA=${requestRow.id}`);
console.log(`DEADLINE_UTC=${deadlines.arrival_deadline_at}`);
console.log('Esperando el Cron real de un minuto hasta superar el plazo de 10 minutos; no se cambiará el reloj ni se insertará GPS.');
while (Date.now() < deadlineMs + 65_000) {
  const remainingSeconds = Math.max(0, Math.ceil((deadlineMs + 65_000 - Date.now()) / 1000));
  console.log(`Espera de Cron: quedan aproximadamente ${Math.ceil(remainingSeconds / 60)} min.`);
  await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, Math.max(1000, deadlineMs + 65_000 - Date.now()))));
}

const { data: reminderRows, error: reminderError } = await admin.client.from('whatsapp_messages')
  .select('id, purpose, status, delivered_at').eq('trip_request_id', requestRow.id).eq('purpose', 'ARRIVAL_REMINDER');
if (reminderError || !reminderRows?.length) throw new Error(`Cron no creó recordatorio WhatsApp para el acompañante: ${reminderError?.message ?? 'sin filas'}`);
if (reminderRows.some((row) => row.status === 'DELIVERED' || row.delivered_at)) throw new Error('La prueba no debe marcar mensajes WhatsApp como entregados.');
assert(true, `Cron creó recordatorio después de 10 min: ${reminderRows.length} registro(s) sin marcar como entregados`);

const { data: passengerConfirmation, error: passengerConfirmError } = await passenger.client.rpc('passenger_confirm_arrival', { trip_uuid: tripId });
if (passengerConfirmError || !passengerConfirmation?.[0]?.ok) throw new Error(`Confirmación de pasajero falló: ${passengerConfirmError?.message ?? passengerConfirmation?.[0]?.reason}`);
const { data: noArrival, error: noArrivalError } = await anonymous.rpc('respond_companion_arrival', { p_token: companions[1].token, p_response: 'NOT_ARRIVED' });
if (noArrivalError || !noArrival?.ok || !noArrival.sos_alert_id) throw new Error(`NO LLEGÓ no creó SOS: ${noArrivalError?.message ?? noArrival?.reason}`);
const alertId = noArrival.sos_alert_id;
const { data: alert, error: alertReadError } = await admin.client.from('sos_alerts').select('id, status, message, latitude, longitude, created_at').eq('id', alertId).single();
if (alertReadError || alert.status !== 'ACTIVE') throw new Error(`El SOS por NO LLEGÓ no es visible a ADMIN: ${alertReadError?.message ?? alert?.status}`);
const { data: sosNotifications, error: notifError } = await admin.client.from('notifications').select('id').eq('user_id', admin.user.id).limit(100);
if (notifError || !sosNotifications?.length) throw new Error(`Falta notificación interna ADMIN: ${notifError?.message}`);
assert(true, 'pasajero confirma por separado; NO LLEGÓ crea SOS activo visible para ADMIN');
const sosWhatsApp = await invokeSosWhatsApp(passenger, alertId);
assert(sosWhatsApp.status === 503 && sosWhatsApp.body?.status === 'REQUESTED', 'alertas WhatsApp quedan en cola, nunca como enviadas/entregadas');
await resolveAsAdmin(admin, alertId, 'SOS por NO LLEGÓ');

for (const session of [driver, passenger]) {
  await session.client.rpc('set_whatsapp_alert_consent', { p_enabled: false });
  await session.client.from('emergency_contacts').update({ whatsapp_consent_at: null }).eq('user_id', session.user.id);
}
assert(true, 'consentimientos ficticios temporales revocados; enlaces cerrados y no quedan destinatarios autorizados para envíos');

console.log(`RESULTADO: viaje=${tripId}; solicitud=${requestRow.id}; QR generado/validado; acceso externo probado; recordatorio real verificado; SOS resuelto.`);
console.log('GPS real, cámara física y envío WhatsApp real no se simularon ni se declaran probados.');
} finally {
  for (const session of cleanupSessions) {
    try {
      await session.client.rpc('set_whatsapp_alert_consent', { p_enabled: false });
      await session.client.from('emergency_contacts').update({ whatsapp_consent_at: null }).eq('user_id', session.user.id);
    } catch {
      console.error(`No se pudo limpiar el consentimiento temporal de ${session.user.email}.`);
    }
  }
}
