/*
# Smart companionship: external arrival confirmation

1. New table
- ride_companions: one row per person who receives a private tracking link for a passenger's trip (two emergency contacts and/or a waiting person). Stores only a SHA-256 hash of the link token, never the token itself.

2. Changed
- trip_requests.arrival_reminder_sent_at: when the 10-minute reminder to the passenger was generated.
- Scheduled job "student-go-arrival-reminders" (every minute) replaces "student-go-overdue-arrivals".
- escalate_overdue_arrivals() is removed: it created an SOS automatically after the deadline. Now the system only sends reminders; SOS is raised by a manual press, a companion reporting "NO HA LLEGADO", or the driver/student SOS button.

3. Security
- RLS enabled on ride_companions. Students can read only their own rows and only non-secret columns. All writes go through security definer functions.
- Public (no login) functions take a random token: get_companion_tracking and respond_companion_arrival.
- Links expire after 12 hours, can be revoked by the student, and close when the companion answers "SÍ, LLEGÓ".

4. Notes
- Delivery: no SMS/WhatsApp provider is configured, so delivery_status stays PROVIDER_NOT_CONFIGURED. Nothing is reported as sent.
*/

ALTER TABLE public.trip_requests ADD COLUMN IF NOT EXISTS arrival_reminder_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS public.ride_companions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_request_id uuid NOT NULL REFERENCES public.trip_requests(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  relationship text NOT NULL CHECK (char_length(relationship) BETWEEN 2 AND 40),
  phone text NOT NULL CHECK (char_length(phone) BETWEEN 8 AND 20),
  source text NOT NULL DEFAULT 'COMPANION' CHECK (source IN ('COMPANION', 'EMERGENCY_CONTACT')),
  token_hash text NOT NULL UNIQUE,
  consent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  closed_at timestamptz,
  delivery_status text NOT NULL DEFAULT 'PROVIDER_NOT_CONFIGURED' CHECK (delivery_status IN ('PROVIDER_NOT_CONFIGURED', 'SENT', 'FAILED')),
  sent_at timestamptz,
  arrival_response text CHECK (arrival_response IN ('ARRIVED', 'NOT_ARRIVED', 'CANNOT_CONFIRM')),
  arrival_responded_at timestamptz,
  sos_alert_id uuid REFERENCES public.sos_alerts(id) ON DELETE SET NULL,
  reminder_attempts integer NOT NULL DEFAULT 0,
  last_reminder_at timestamptz,
  last_reminder_result text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ride_companions_request_idx ON public.ride_companions (trip_request_id);

ALTER TABLE public.ride_companions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.ride_companions FROM anon, authenticated;
GRANT SELECT (id, trip_request_id, student_id, name, relationship, phone, source, consent_at, expires_at, revoked_at, closed_at, delivery_status, sent_at, arrival_response, arrival_responded_at, reminder_attempts, last_reminder_at, last_reminder_result, created_at)
  ON public.ride_companions TO authenticated;

DROP POLICY IF EXISTS "select_own_ride_companions" ON public.ride_companions;
CREATE POLICY "select_own_ride_companions" ON public.ride_companions FOR SELECT
  TO authenticated USING (student_id = auth.uid());

CREATE OR REPLACE FUNCTION public.create_ride_companion(p_trip_request_id uuid, p_name text, p_relationship text, p_phone text, p_source text, p_consent boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  req record;
  active_count integer;
  tok text;
  new_id uuid;
  exp timestamptz := now() + interval '12 hours';
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'NO_AUTENTICADO'); END IF;
  IF p_consent IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_REQUERIDO'); END IF;
  IF p_source NOT IN ('COMPANION', 'EMERGENCY_CONTACT') THEN RETURN jsonb_build_object('ok', false, 'reason', 'FUENTE_INVALIDA'); END IF;
  IF char_length(trim(coalesce(p_name, ''))) NOT BETWEEN 2 AND 80 THEN RETURN jsonb_build_object('ok', false, 'reason', 'NOMBRE_INVALIDO'); END IF;
  IF char_length(trim(coalesce(p_relationship, ''))) NOT BETWEEN 2 AND 40 THEN RETURN jsonb_build_object('ok', false, 'reason', 'RELACION_INVALIDA'); END IF;
  IF trim(coalesce(p_phone, '')) !~ '^\+?[0-9 ()-]{8,20}$' THEN RETURN jsonb_build_object('ok', false, 'reason', 'TELEFONO_INVALIDO'); END IF;

  SELECT q.id, q.status, q.trip_started_at INTO req
  FROM public.trip_requests q
  WHERE q.id = p_trip_request_id AND q.passenger_id = auth.uid();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;
  IF req.status <> 'ACCEPTED' OR req.trip_started_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_NO_EN_CURSO'); END IF;

  SELECT count(*) INTO active_count FROM public.ride_companions rc
  WHERE rc.trip_request_id = p_trip_request_id AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now();
  IF active_count >= 3 THEN RETURN jsonb_build_object('ok', false, 'reason', 'LIMITE_ALCANZADO'); END IF;

  tok := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  INSERT INTO public.ride_companions (trip_request_id, student_id, name, relationship, phone, source, token_hash, expires_at)
  VALUES (p_trip_request_id, auth.uid(), trim(p_name), trim(p_relationship), trim(p_phone), p_source, encode(extensions.digest(tok, 'sha256'), 'hex'), exp)
  RETURNING id INTO new_id;

  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'companion_id', new_id, 'token', tok, 'expires_at', exp);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_ride_companion(p_companion_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ride_companions SET revoked_at = now()
  WHERE id = p_companion_id AND student_id = auth.uid() AND revoked_at IS NULL AND closed_at IS NULL;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'reason', 'OK'); END IF;
  RETURN jsonb_build_object('ok', false, 'reason', 'NO_ENCONTRADO');
END;
$$;

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
  SELECT rc.id, rc.name, rc.expires_at, rc.revoked_at, rc.closed_at, rc.arrival_response, rc.arrival_responded_at,
         q.trip_id, q.passenger_confirmed_at, q.trip_started_at, q.trip_completed_at,
         t.origin_text, t.destination_text, t.departure_at, t.status AS trip_status, p.full_name
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
    FROM public.ride_trackings r WHERE r.trip_id = c.trip_id ORDER BY r.recorded_at DESC LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'OK',
    'student_first_name', split_part(coalesce(c.full_name, 'Estudiante'), ' ', 1),
    'companion_name', c.name,
    'expires_at', c.expires_at,
    'origin', c.origin_text,
    'destination', c.destination_text,
    'departure_at', c.departure_at,
    'trip_status', c.trip_status,
    'trip_started', c.trip_started_at IS NOT NULL,
    'trip_completed', c.trip_completed_at IS NOT NULL,
    'student_confirmed_at', c.passenger_confirmed_at,
    'companion_response', c.arrival_response,
    'companion_responded_at', c.arrival_responded_at,
    'latitude', lat,
    'longitude', lng,
    'location_at', loc_at
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
BEGIN
  IF p_response NOT IN ('ARRIVED', 'NOT_ARRIVED', 'CANNOT_CONFIRM') THEN RETURN jsonb_build_object('ok', false, 'reason', 'RESPUESTA_INVALIDA'); END IF;

  SELECT rc.id, rc.name, rc.relationship, rc.student_id, rc.revoked_at, rc.closed_at, rc.expires_at, rc.arrival_response,
         q.trip_id, q.trip_completed_at
  INTO c
  FROM public.ride_companions rc
  JOIN public.trip_requests q ON q.id = rc.trip_request_id
  WHERE rc.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_NO_VALIDO'); END IF;
  IF c.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_REVOCADO'); END IF;
  IF c.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ACOMPANAMIENTO_FINALIZADO'); END IF;
  IF c.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_EXPIRADO'); END IF;
  IF c.trip_completed_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_EN_CURSO'); END IF;
  IF c.arrival_response = 'NOT_ARRIVED' AND p_response = 'NOT_ARRIVED' THEN RETURN jsonb_build_object('ok', true, 'reason', 'YA_REGISTRADO'); END IF;

  IF p_response = 'NOT_ARRIVED' THEN
    SELECT r.latitude, r.longitude INTO lat, lng
    FROM public.ride_trackings r WHERE r.trip_id = c.trip_id ORDER BY r.recorded_at DESC LIMIT 1;

    INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status, auto_triggered)
    VALUES (c.student_id, c.trip_id, 'STUDENT', lat, lng,
            'Acompañante ' || c.name || ' (' || c.relationship || ') reportó que el estudiante NO HA LLEGADO.', 'ACTIVE', false)
    RETURNING id INTO new_sos;
  END IF;

  UPDATE public.ride_companions rc SET
    arrival_response = p_response,
    arrival_responded_at = now(),
    closed_at = CASE WHEN p_response = 'ARRIVED' THEN now() ELSE rc.closed_at END,
    sos_alert_id = coalesce(new_sos, rc.sos_alert_id)
  WHERE rc.id = c.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'response', p_response);
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
BEGIN
  FOR q IN
    SELECT tr.id, tr.passenger_id, tr.trip_id FROM public.trip_requests tr
    WHERE tr.status = 'ACCEPTED' AND tr.trip_completed_at IS NOT NULL AND tr.arrival_deadline_at <= now()
      AND tr.passenger_confirmed_at IS NULL AND tr.arrival_reminder_sent_at IS NULL
  LOOP
    PERFORM public.notify_user(q.passenger_id, 'Confirma que llegaste bien',
      'Pasaron 10 minutos desde que terminó tu viaje. Confirma tu llegada.', 'SAFETY', 'trips', q.trip_id);
    UPDATE public.trip_requests SET arrival_reminder_sent_at = now() WHERE id = q.id;
    n := n + 1;
  END LOOP;

  FOR c IN
    SELECT rc.id FROM public.ride_companions rc
    JOIN public.trip_requests tr ON tr.id = rc.trip_request_id
    WHERE tr.trip_completed_at IS NOT NULL AND tr.arrival_deadline_at <= now()
      AND rc.arrival_response IS NULL AND rc.revoked_at IS NULL AND rc.closed_at IS NULL
      AND rc.expires_at > now() AND rc.last_reminder_at IS NULL
  LOOP
    UPDATE public.ride_companions SET last_reminder_at = now(), reminder_attempts = reminder_attempts + 1,
      last_reminder_result = 'PROVIDER_NOT_CONFIGURED' WHERE id = c.id;
    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

DROP FUNCTION IF EXISTS public.escalate_overdue_arrivals();

DO $$
BEGIN
  BEGIN PERFORM cron.unschedule('student-go-overdue-arrivals'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule('student-go-arrival-reminders'); EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('student-go-arrival-reminders', '* * * * *', 'SELECT public.send_arrival_reminders()');
END $$;

REVOKE EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.revoke_ride_companion(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_ride_companion(uuid) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.get_companion_tracking(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_companion_tracking(text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.respond_companion_arrival(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.respond_companion_arrival(text, text) TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.send_arrival_reminders() FROM PUBLIC, anon, authenticated;
