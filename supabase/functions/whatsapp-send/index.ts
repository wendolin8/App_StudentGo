import { corsHeaders, dispatchMessage, getAuthenticatedUser, jsonResponse, sendPendingFor, serviceClient, sha256Hex, type WaMessage } from '../_shared/whatsapp.ts';

type RequestBody = { action?: string; companionId?: string; token?: string; sosAlertId?: string };

Deno.serve(async (request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (request.method !== 'POST') return jsonResponse({ ok: false, message: 'Método no permitido.' }, 405, origin);

  try {
    const body = await request.json() as RequestBody;
    const db = serviceClient();

    if (body.action === 'COMPANION_NO_ARRIVED') {
      if (!body.token || body.token.length < 32) return jsonResponse({ ok: false, message: 'Enlace de acompañamiento no válido.' }, 400, origin);
      const tokenHash = await sha256Hex(body.token);
      const { data: companion } = await db.from('ride_companions')
        .select('id, sos_alert_id, arrival_response, revoked_at, expires_at')
        .eq('token_hash', tokenHash).maybeSingle();
      if (!companion || companion.arrival_response !== 'NOT_ARRIVED' || !companion.sos_alert_id
        || companion.revoked_at || new Date(companion.expires_at).getTime() <= Date.now()) {
        return jsonResponse({ ok: false, message: 'No se encontró un incidente autorizado para este enlace.' }, 403, origin);
      }
      const outcomes = await sendPendingFor(db, { sos_alert_id: companion.sos_alert_id });
      return outcomeResponse(outcomes, origin);
    }

    const authenticated = await getAuthenticatedUser(request);
    if (!authenticated) return jsonResponse({ ok: false, message: 'Sesión no válida.' }, 401, origin);

    if (body.action === 'SHARE_LINK') {
      if (!body.companionId || !body.token) return jsonResponse({ ok: false, message: 'Faltan datos del enlace.' }, 400, origin);
      const tokenHash = await sha256Hex(body.token);
      const { data: companion, error: companionError } = await db.from('ride_companions')
        .select('id, student_id, trip_request_id, name, phone, source, token_hash, token_ciphertext, consent_at, whatsapp_consent_at, revoked_at, closed_at, expires_at')
        .eq('id', body.companionId).eq('student_id', authenticated.id).maybeSingle();
      if (companionError || !companion || companion.token_hash !== tokenHash || !companion.consent_at || !companion.whatsapp_consent_at || companion.revoked_at || companion.closed_at
        || new Date(companion.expires_at).getTime() <= Date.now()) {
        return jsonResponse({ ok: false, message: 'No se pudo validar el enlace privado.' }, 403, origin);
      }

      const { data: profile } = await db.from('profiles').select('full_name, whatsapp_alerts_consent_at').eq('id', authenticated.id).maybeSingle();
      if (!profile?.whatsapp_alerts_consent_at) return jsonResponse({ ok: false, message: 'Activa el consentimiento de WhatsApp en Perfil → Seguridad.' }, 403, origin);
      let contactId: string | null = null;
      if (companion.source === 'EMERGENCY_CONTACT') {
        const { data: contact } = await db.from('emergency_contacts').select('id, whatsapp_consent_at')
          .eq('user_id', authenticated.id).eq('phone', companion.phone).maybeSingle();
        if (!contact?.whatsapp_consent_at) return jsonResponse({ ok: false, message: 'Este contacto no tiene autorización de WhatsApp vigente.' }, 403, origin);
        contactId = contact.id;
      }

      const { encryptTrackingToken } = await import('../_shared/whatsapp.ts');
      const encryptedToken = await encryptTrackingToken(body.token);
      const { error: saveTokenError } = await db.from('ride_companions').update({ token_ciphertext: encryptedToken })
        .eq('id', companion.id).eq('student_id', authenticated.id);
      if (saveTokenError) return jsonResponse({ ok: false, message: 'No se pudo proteger el enlace para el envío programado.' }, 500, origin);

      const { data: existing } = await db.from('whatsapp_messages').select('*').eq('dedupe_key', `TRIP_SHARE:${companion.id}`).maybeSingle();
      let message = existing as WaMessage | null;
      if (!message) {
        const { data, error } = await db.from('whatsapp_messages').insert({
          dedupe_key: `TRIP_SHARE:${companion.id}`,
          owner_id: authenticated.id,
          contact_id: contactId,
          companion_id: companion.id,
          trip_request_id: companion.trip_request_id,
          purpose: 'TRIP_SHARE',
          recipient_phone: companion.phone,
          template_name: 'studentgo_trip_share_v1',
          template_parameters: [companion.name, profile.full_name ?? 'Estudiante'],
        }).select('*').maybeSingle();
        if (error || !data) return jsonResponse({ ok: false, message: 'No se pudo registrar la solicitud de WhatsApp.' }, 500, origin);
        message = data as WaMessage;
      }
      const result = await dispatchMessage(db, message);
      if (result.status === 'REQUESTED') return jsonResponse({ ok: false, status: result.status, message: 'El enlace quedó protegido, pero WhatsApp Business aún no está configurado; no se envió ningún mensaje.' }, 503, origin);
      return jsonResponse({ ok: result.status === 'ACCEPTED' || result.status === 'DELIVERED', status: result.status, message: result.status === 'ACCEPTED' ? 'Meta aceptó la solicitud; la entrega aún está pendiente.' : result.status === 'DELIVERED' ? 'WhatsApp confirmó la entrega.' : 'Meta rechazó el mensaje. Revisa el estado del envío.' }, result.status === 'FAILED' ? 502 : 200, origin);
    }

    if (body.action === 'SOS_ALERT') {
      if (!body.sosAlertId) return jsonResponse({ ok: false, message: 'Falta el identificador del incidente.' }, 400, origin);
      const { data: alert } = await db.from('sos_alerts').select('id, user_id').eq('id', body.sosAlertId).maybeSingle();
      if (!alert || alert.user_id !== authenticated.id) return jsonResponse({ ok: false, message: 'Incidente no autorizado.' }, 403, origin);
      const outcomes = await sendPendingFor(db, { sos_alert_id: alert.id });
      return outcomeResponse(outcomes, origin);
    }

    return jsonResponse({ ok: false, message: 'Acción no reconocida.' }, 400, origin);
  } catch (error) {
    console.error('whatsapp-send failed', error instanceof Error ? error.message : 'unknown');
    return jsonResponse({ ok: false, message: 'No se pudo procesar el envío de WhatsApp.' }, 500, origin);
  }
});

function outcomeResponse(outcomes: Array<{ id: string; status: string; reason?: string }>, origin: string | null): Response {
  if (!outcomes.length) return jsonResponse({ ok: true, status: 'SKIPPED_CONSENT', message: 'No hay mensajes autorizados pendientes; no se envió WhatsApp.' }, 200, origin);
  const failed = outcomes.some((item) => item.status === 'FAILED');
  const requested = outcomes.some((item) => item.status === 'REQUESTED');
  const status = failed ? 'FAILED' : requested ? 'REQUESTED' : outcomes.every((item) => item.status === 'DELIVERED') ? 'DELIVERED' : 'ACCEPTED';
  return jsonResponse({
    ok: !failed && !requested,
    status,
    messages: outcomes.map(({ id, status: itemStatus }) => ({ id, status: itemStatus })),
    message: failed ? 'Uno o más mensajes fallaron; ningún envío se reportó como entregado sin confirmación de Meta.'
      : requested ? 'WhatsApp Business no está configurado todavía; los mensajes no se enviaron.'
        : status === 'DELIVERED' ? 'Meta confirmó la entrega de los mensajes.' : 'Meta aceptó las solicitudes; la entrega sigue pendiente.',
  }, requested ? 503 : failed ? 502 : 200, origin);
}
