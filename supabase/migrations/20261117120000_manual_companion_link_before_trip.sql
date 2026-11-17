-- A passenger can prepare one private companion link after QR boarding and
-- before the driver starts the trip. Manual links do not use contact details
-- or any external messaging integration.

ALTER TABLE public.ride_companions
  ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE public.ride_companions
  DROP CONSTRAINT IF EXISTS ride_companions_phone_check;
ALTER TABLE public.ride_companions
  ADD CONSTRAINT ride_companions_phone_check
  CHECK (phone IS NULL OR char_length(phone) BETWEEN 8 AND 20);
ALTER TABLE public.ride_companions
  DROP CONSTRAINT IF EXISTS ride_companions_source_check;
ALTER TABLE public.ride_companions
  ADD CONSTRAINT ride_companions_source_check
  CHECK (source IN ('COMPANION', 'EMERGENCY_CONTACT', 'MANUAL'));

CREATE TABLE IF NOT EXISTS public.companion_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  companion_id uuid NOT NULL UNIQUE REFERENCES public.ride_companions(id) ON DELETE CASCADE,
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  passenger_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWED', 'RESOLVED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.companion_incidents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.companion_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.companion_incidents TO authenticated;
CREATE POLICY companion_incidents_admin_read
  ON public.companion_incidents FOR SELECT TO authenticated
  USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.validate_ride_qr(token_input text)
RETURNS TABLE(valid boolean, request_id uuid, trip_id uuid, passenger_id uuid, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  req public.trip_requests%ROWTYPE;
  trip_row public.trips%ROWTYPE;
  changed_rows integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'NO_AUTENTICADO';
    RETURN;
  END IF;

  SELECT q.* INTO req FROM public.trip_requests q WHERE q.qr_token = token_input;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'TOKEN_NO_ENCONTRADO';
    RETURN;
  END IF;

  SELECT t.* INTO trip_row FROM public.trips t WHERE t.id = req.trip_id FOR UPDATE;
  IF NOT FOUND OR trip_row.driver_id IS DISTINCT FROM auth.uid() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'NO_ES_CONDUCTOR';
    RETURN;
  END IF;
  SELECT q.* INTO req FROM public.trip_requests q WHERE q.id = req.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'TOKEN_NO_ENCONTRADO';
    RETURN;
  END IF;
  IF req.qr_used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO';
    RETURN;
  END IF;
  IF req.status <> 'ACCEPTED' THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'SOLICITUD_NO_ACEPTADA';
    RETURN;
  END IF;
  IF req.qr_issued_at IS NULL OR req.qr_issued_at + interval '2 hours' < now() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_EXPIRADO';
    RETURN;
  END IF;
  IF trip_row.status NOT IN ('PUBLISHED', 'FULL', 'IN_PROGRESS') THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'VIAJE_NO_ACTIVO';
    RETURN;
  END IF;

  UPDATE public.trip_requests q
  SET qr_used_at = now(),
      trip_started_at = CASE WHEN trip_row.status = 'IN_PROGRESS' THEN coalesce(q.trip_started_at, now()) ELSE q.trip_started_at END
  WHERE q.id = req.id AND q.qr_used_at IS NULL AND q.status = 'ACCEPTED';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO';
    RETURN;
  END IF;

  RETURN QUERY SELECT true, req.id, req.trip_id, req.passenger_id, 'OK';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_ride_qr(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_ride_qr(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.start_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RETURN QUERY SELECT false, 'NO_AUTENTICADO'; RETURN; END IF;

  SELECT * INTO trip_row FROM public.trips WHERE id = trip_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'VIAJE_NO_EXISTE'; RETURN; END IF;
  IF trip_row.driver_id IS DISTINCT FROM auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status NOT IN ('PUBLISHED', 'FULL') THEN RETURN QUERY SELECT false, 'VIAJE_NO_DISPONIBLE'; RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.trip_requests
    WHERE trip_id = trip_uuid AND status = 'ACCEPTED' AND qr_used_at IS NOT NULL
  ) THEN RETURN QUERY SELECT false, 'ABORDAJE_REQUERIDO'; RETURN; END IF;

  UPDATE public.trips SET status = 'IN_PROGRESS', updated_at = now() WHERE id = trip_uuid;
  UPDATE public.trip_requests SET trip_started_at = now()
    WHERE trip_id = trip_uuid AND status = 'ACCEPTED'
      AND qr_used_at IS NOT NULL AND trip_started_at IS NULL;
  RETURN QUERY SELECT true, 'OK';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.start_ride(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_ride(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_manual_companion_link(
  p_trip_request_id uuid,
  p_location_consent boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  req record;
  trip_status text;
  active_count integer;
  tok text;
  new_id uuid;
  exp timestamptz := now() + interval '12 hours';
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'NO_AUTENTICADO'); END IF;
  IF p_location_consent IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_REQUERIDO'); END IF;

  SELECT q.id, q.trip_id
  INTO req
  FROM public.trip_requests q
  WHERE q.id = p_trip_request_id AND q.passenger_id = auth.uid();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;

  SELECT t.status INTO trip_status FROM public.trips t WHERE t.id = req.trip_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;
  SELECT q.id, q.trip_id, q.status, q.qr_used_at, q.trip_completed_at INTO req
    FROM public.trip_requests q WHERE q.id = req.id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;
  IF req.status <> 'ACCEPTED' OR req.qr_used_at IS NULL OR req.trip_completed_at IS NOT NULL
    OR trip_status NOT IN ('PUBLISHED', 'FULL', 'IN_PROGRESS') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ABORDAJE_REQUERIDO');
  END IF;

  SELECT count(*) INTO active_count
  FROM public.ride_companions rc
  JOIN public.trip_requests q ON q.id = rc.trip_request_id
  WHERE q.trip_id = req.trip_id AND rc.student_id = auth.uid()
    AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now();
  IF active_count >= 3 THEN RETURN jsonb_build_object('ok', false, 'reason', 'LIMITE_ALCANZADO'); END IF;

  INSERT INTO public.trip_companionship_preferences
    (trip_id, user_id, selection, active, location_consent_at, disabled_at)
  VALUES (req.trip_id, auth.uid(), 'BOTH', true, now(), NULL)
  ON CONFLICT (trip_id, user_id) DO UPDATE SET
    selection = 'BOTH', active = true, location_consent_at = now(),
    disabled_at = NULL, updated_at = now();

  tok := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  INSERT INTO public.ride_companions
    (trip_request_id, student_id, actor_role, name, relationship, phone, source, token_hash, expires_at, delivery_status)
  VALUES
    (p_trip_request_id, auth.uid(), 'STUDENT', 'Persona de confianza', 'Acompañamiento manual',
     NULL, 'MANUAL', encode(extensions.digest(tok, 'sha256'), 'hex'), exp, 'PROVIDER_NOT_CONFIGURED')
  RETURNING id INTO new_id;

  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'companion_id', new_id, 'token', tok, 'expires_at', exp);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_manual_companion_link(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_companion_link(uuid, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_companion_tracking(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  c record;
  lat double precision;
  lng double precision;
  loc_at timestamptz;
BEGIN
  SELECT rc.id, rc.student_id, rc.name, rc.source, rc.expires_at, rc.revoked_at, rc.closed_at,
         rc.arrival_response, rc.arrival_responded_at, rc.last_reminder_at,
         q.trip_id, q.passenger_confirmed_at, q.arrival_deadline_at,
         q.trip_started_at, q.trip_completed_at, t.origin_text, t.destination_text,
         t.departure_at, t.status AS trip_status, p.full_name
  INTO c
  FROM public.ride_companions rc
  JOIN public.trip_requests q ON q.id = rc.trip_request_id
  JOIN public.trips t ON t.id = q.trip_id
  LEFT JOIN public.profiles p ON p.id = rc.student_id
  WHERE rc.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_NO_VALIDO'); END IF;
  IF c.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_REVOCADO'); END IF;
  IF c.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ACOMPANAMIENTO_FINALIZADO'); END IF;
  IF c.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_EXPIRADO'); END IF;

  IF c.trip_status = 'IN_PROGRESS' THEN
    SELECT r.latitude, r.longitude, r.recorded_at INTO lat, lng, loc_at
    FROM public.ride_trackings r
    WHERE r.trip_id = c.trip_id AND r.recorded_by = c.student_id
    ORDER BY r.recorded_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'reason', 'OK',
    'student_first_name', split_part(coalesce(c.full_name, 'Estudiante'), ' ', 1),
    'companion_name', c.name, 'manual_link', c.source = 'MANUAL',
    'expires_at', c.expires_at, 'origin', c.origin_text, 'destination', c.destination_text,
    'departure_at', c.departure_at, 'trip_status', c.trip_status,
    'trip_started', c.trip_started_at IS NOT NULL, 'trip_completed', c.trip_completed_at IS NOT NULL,
    'arrival_deadline_at', c.arrival_deadline_at, 'companion_reminded_at', c.last_reminder_at,
    'student_confirmed_at', c.passenger_confirmed_at, 'companion_response', c.arrival_response,
    'companion_responded_at', c.arrival_responded_at,
    'latitude', lat, 'longitude', lng, 'location_at', loc_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.respond_companion_arrival(p_token text, p_response text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  c record;
  lat double precision;
  lng double precision;
  new_sos uuid;
  new_incident uuid;
BEGIN
  IF p_response IS NULL OR p_response NOT IN ('ARRIVED', 'NOT_ARRIVED', 'CANNOT_CONFIRM') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'RESPUESTA_INVALIDA');
  END IF;

  SELECT rc.id, rc.name, rc.relationship, rc.student_id, rc.actor_role, rc.source,
         rc.revoked_at, rc.closed_at, rc.expires_at, rc.arrival_response, rc.sos_alert_id,
         q.trip_id, q.trip_completed_at
  INTO c
  FROM public.ride_companions rc
  JOIN public.trip_requests q ON q.id = rc.trip_request_id
  WHERE rc.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  FOR UPDATE OF rc;

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_NO_VALIDO'); END IF;
  IF c.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_REVOCADO'); END IF;
  IF c.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ACOMPANAMIENTO_FINALIZADO'); END IF;
  IF c.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_EXPIRADO'); END IF;
  IF c.trip_completed_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_EN_CURSO'); END IF;

  IF c.source = 'MANUAL' AND c.arrival_response IS NOT NULL THEN
    SELECT ci.id INTO new_incident FROM public.companion_incidents ci WHERE ci.companion_id = c.id;
    RETURN jsonb_build_object('ok', true, 'reason', 'YA_REGISTRADO',
      'response', c.arrival_response, 'manual_link', true, 'incident_id', new_incident);
  END IF;
  IF c.source <> 'MANUAL' AND c.arrival_response = 'NOT_ARRIVED' AND p_response = 'NOT_ARRIVED' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'YA_REGISTRADO');
  END IF;

  IF p_response = 'NOT_ARRIVED' AND c.source = 'MANUAL' THEN
    INSERT INTO public.companion_incidents (companion_id, trip_id, passenger_id)
    VALUES (c.id, c.trip_id, c.student_id)
    ON CONFLICT (companion_id) DO NOTHING
    RETURNING id INTO new_incident;
    IF new_incident IS NULL THEN
      SELECT ci.id INTO new_incident FROM public.companion_incidents ci WHERE ci.companion_id = c.id;
    ELSE
      PERFORM public.notify_user(c.student_id, 'Reporte registrado', 'Una persona de confianza reportó que podrías no haber llegado. Confirma cómo estás en Student Go.', 'SAFETY', 'security', new_incident);
      PERFORM public.notify_user(admin.id, 'Reporte de llegada de acompañante', 'Una persona de confianza reportó que el pasajero no llegó. Revisa el reporte en Administración.', 'SAFETY', 'security', new_incident)
      FROM public.profiles admin WHERE admin.role = 'ADMIN';
    END IF;
  ELSIF p_response = 'NOT_ARRIVED' THEN
    SELECT r.latitude, r.longitude INTO lat, lng
    FROM public.ride_trackings r
    WHERE r.trip_id = c.trip_id AND r.recorded_by = c.student_id
    ORDER BY r.recorded_at DESC LIMIT 1;
    INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status, auto_triggered)
    VALUES (c.student_id, c.trip_id, c.actor_role, lat, lng,
      'Acompañante ' || c.name || ' (' || c.relationship || ') reportó que el usuario NO HA LLEGADO.',
      'ACTIVE', false) RETURNING id INTO new_sos;
  END IF;

  UPDATE public.ride_companions
  SET arrival_response = p_response,
      arrival_responded_at = now(),
      closed_at = CASE WHEN p_response = 'ARRIVED' AND c.source <> 'MANUAL' THEN now() ELSE closed_at END,
      sos_alert_id = coalesce(new_sos, sos_alert_id)
  WHERE id = c.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'response', p_response,
    'sos_alert_id', new_sos, 'incident_id', new_incident, 'manual_link', c.source = 'MANUAL');
END;
$$;

CREATE OR REPLACE FUNCTION public.send_arrival_reminders()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
  q record;
  c record;
  student_name text;
BEGIN
  FOR q IN
    SELECT tr.id, tr.passenger_id, tr.trip_id FROM public.trip_requests tr
    WHERE tr.status = 'ACCEPTED' AND tr.trip_completed_at IS NOT NULL
      AND tr.arrival_deadline_at <= now() AND tr.passenger_confirmed_at IS NULL
      AND tr.arrival_reminder_sent_at IS NULL
  LOOP
    PERFORM public.notify_user(q.passenger_id, 'Confirma que llegaste bien',
      'Pasaron 10 minutos desde que terminó tu viaje. Confirma tu llegada.', 'SAFETY', 'trips', q.trip_id);
    UPDATE public.trip_requests SET arrival_reminder_sent_at = now() WHERE id = q.id;
    n := n + 1;
  END LOOP;

  FOR c IN
    SELECT rc.id, rc.source FROM public.ride_companions rc
    JOIN public.trip_requests tr ON tr.id = rc.trip_request_id
    WHERE rc.source = 'MANUAL' AND tr.trip_completed_at IS NOT NULL
      AND tr.arrival_deadline_at <= now() AND rc.arrival_response IS NULL
      AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now()
      AND rc.last_reminder_at IS NULL
  LOOP
    UPDATE public.ride_companions SET last_reminder_at = now(),
      reminder_attempts = reminder_attempts + 1, last_reminder_result = 'IN_APP'
    WHERE id = c.id;
    n := n + 1;
  END LOOP;

  FOR c IN
    SELECT rc.id, rc.student_id, rc.trip_request_id, rc.name, rc.phone, ec.id AS contact_id
    FROM public.ride_companions rc
    JOIN public.trip_requests tr ON tr.id = rc.trip_request_id
    JOIN public.profiles p ON p.id = rc.student_id
    LEFT JOIN public.emergency_contacts ec ON ec.user_id = rc.student_id AND ec.phone = rc.phone
    WHERE rc.source <> 'MANUAL' AND tr.trip_completed_at IS NOT NULL
      AND tr.arrival_deadline_at <= now() AND rc.arrival_response IS NULL
      AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now()
      AND rc.last_reminder_at IS NULL AND rc.whatsapp_consent_at IS NOT NULL
      AND p.whatsapp_alerts_consent_at IS NOT NULL
  LOOP
    SELECT full_name INTO student_name FROM public.profiles WHERE id = c.student_id;
    INSERT INTO public.whatsapp_messages
      (dedupe_key, owner_id, contact_id, companion_id, trip_request_id, purpose, recipient_phone, template_name, template_parameters)
    VALUES
      ('ARRIVAL_REMINDER:' || c.id::text, c.student_id, c.contact_id, c.id, c.trip_request_id,
       'ARRIVAL_REMINDER', c.phone, 'studentgo_arrival_reminder_v1',
       jsonb_build_array(c.name, coalesce(student_name, 'Estudiante')))
    ON CONFLICT (dedupe_key) DO NOTHING;
    UPDATE public.ride_companions SET last_reminder_at = now(),
      reminder_attempts = reminder_attempts + 1, last_reminder_result = 'REQUESTED'
    WHERE id = c.id;
    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.send_arrival_reminders() FROM PUBLIC, anon, authenticated;
