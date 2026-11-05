-- WhatsApp is the only external messaging channel for Student Go safety flows.
-- No provider call is made from SQL. This migration creates consent and delivery records.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whatsapp_alerts_consent_at timestamptz;

ALTER TABLE public.emergency_contacts
  ADD COLUMN IF NOT EXISTS whatsapp_consent_at timestamptz;

UPDATE public.emergency_contacts SET notification_method = 'WHATSAPP'
WHERE notification_method IS DISTINCT FROM 'WHATSAPP';
ALTER TABLE public.emergency_contacts ALTER COLUMN notification_method SET DEFAULT 'WHATSAPP';
ALTER TABLE public.emergency_contacts DROP CONSTRAINT IF EXISTS emergency_contacts_notification_method_check;
ALTER TABLE public.emergency_contacts ADD CONSTRAINT emergency_contacts_notification_method_check
  CHECK (notification_method = 'WHATSAPP');
GRANT UPDATE (name, relationship, phone, notification_method, whatsapp_consent_at)
  ON public.emergency_contacts TO authenticated;
REVOKE DELETE ON public.emergency_contacts FROM authenticated;
DROP POLICY IF EXISTS emergency_contacts_delete_own ON public.emergency_contacts;

CREATE OR REPLACE FUNCTION public.set_whatsapp_alert_consent(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN false; END IF;
  IF p_enabled THEN
    IF (SELECT count(*) FROM public.emergency_contacts ec WHERE ec.user_id = auth.uid()
        AND ec.whatsapp_consent_at IS NOT NULL AND ec.notification_method = 'WHATSAPP') <> 2 THEN
      RETURN false;
    END IF;
    UPDATE public.profiles SET whatsapp_alerts_consent_at = now() WHERE id = auth.uid();
  ELSE
    UPDATE public.profiles SET whatsapp_alerts_consent_at = NULL WHERE id = auth.uid();
    UPDATE public.ride_companions SET revoked_at = now()
      WHERE student_id = auth.uid() AND revoked_at IS NULL AND closed_at IS NULL;
  END IF;
  RETURN true;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.set_whatsapp_alert_consent(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_whatsapp_alert_consent(boolean) TO authenticated;

ALTER TABLE public.ride_companions
  ADD COLUMN IF NOT EXISTS token_ciphertext text;
ALTER TABLE public.ride_companions ADD COLUMN IF NOT EXISTS actor_role text NOT NULL DEFAULT 'STUDENT'
  CHECK (actor_role IN ('STUDENT', 'DRIVER'));
ALTER TABLE public.ride_companions ADD COLUMN IF NOT EXISTS whatsapp_consent_at timestamptz;
ALTER TABLE public.ride_companions DROP CONSTRAINT IF EXISTS ride_companions_name_check;
ALTER TABLE public.ride_companions ADD CONSTRAINT ride_companions_name_check CHECK (char_length(name) BETWEEN 2 AND 100);
ALTER TABLE public.ride_companions DROP CONSTRAINT IF EXISTS ride_companions_relationship_check;
ALTER TABLE public.ride_companions ADD CONSTRAINT ride_companions_relationship_check CHECK (char_length(relationship) BETWEEN 2 AND 60);
UPDATE public.ride_companions SET delivery_status = 'PROVIDER_NOT_CONFIGURED' WHERE delivery_status = 'SENT';
ALTER TABLE public.ride_companions DROP CONSTRAINT IF EXISTS ride_companions_delivery_status_check;
ALTER TABLE public.ride_companions ALTER COLUMN delivery_status SET DEFAULT 'REQUESTED';
ALTER TABLE public.ride_companions ADD CONSTRAINT ride_companions_delivery_status_check
  CHECK (delivery_status IN ('REQUESTED', 'ACCEPTED', 'DELIVERED', 'FAILED', 'CANCELLED', 'PROVIDER_NOT_CONFIGURED'));

CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.emergency_contacts(id) ON DELETE SET NULL,
  companion_id uuid REFERENCES public.ride_companions(id) ON DELETE SET NULL,
  sos_alert_id uuid REFERENCES public.sos_alerts(id) ON DELETE SET NULL,
  trip_request_id uuid REFERENCES public.trip_requests(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('TRIP_SHARE', 'ARRIVAL_CONFIRMATION', 'ARRIVAL_REMINDER', 'SOS_ALERT')),
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^\+[1-9][0-9]{9,14}$'),
  template_name text NOT NULL,
  template_parameters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(template_parameters) = 'array'),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'ACCEPTED', 'DELIVERED', 'FAILED', 'CANCELLED')),
  provider_message_id text UNIQUE,
  provider_status text,
  failure_detail text,
  claimed_at timestamptz,
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  cancelled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_pending_idx
  ON public.whatsapp_messages (requested_at) WHERE status = 'REQUESTED';
CREATE INDEX IF NOT EXISTS whatsapp_messages_owner_idx
  ON public.whatsapp_messages (owner_id, requested_at DESC);
ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_messages FROM anon, authenticated;
GRANT SELECT ON public.whatsapp_messages TO authenticated;
CREATE POLICY whatsapp_messages_owner_or_admin_read ON public.whatsapp_messages
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'ADMIN'
  ));

-- Signup stores exactly two opted-in WhatsApp contacts atomically with the profile.
CREATE OR REPLACE FUNCTION public.handle_new_student_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  contacts jsonb := NEW.raw_user_meta_data->'emergency_contacts';
  contact jsonb;
  phone text;
BEGIN
  INSERT INTO public.profiles (id, email, full_name, student_number, whatsapp_alerts_consent_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), 'Estudiante UTP'),
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'student_number', ''), 'PENDIENTE-' || replace(NEW.id::text, '-', '')),
    CASE WHEN NEW.raw_user_meta_data->>'whatsapp_alerts_consent' = 'true' THEN now() ELSE NULL END
  )
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();

  IF contacts IS NOT NULL THEN
    IF jsonb_typeof(contacts) <> 'array' OR jsonb_array_length(contacts) <> 2
      OR NEW.raw_user_meta_data->>'whatsapp_alerts_consent' IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'TWO_WHATSAPP_CONTACTS_AND_USER_CONSENT_REQUIRED';
    END IF;

    FOR contact IN SELECT value FROM jsonb_array_elements(contacts)
    LOOP
      phone := regexp_replace(coalesce(contact->>'phone', ''), '[ ()-]', '', 'g');
      IF char_length(trim(coalesce(contact->>'name', ''))) NOT BETWEEN 2 AND 100
        OR char_length(trim(coalesce(contact->>'relationship', ''))) NOT BETWEEN 2 AND 60
        OR phone !~ '^\+[1-9][0-9]{9,14}$'
        OR contact->>'whatsapp_consent' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'INVALID_OR_UNCONSENTED_WHATSAPP_CONTACT';
      END IF;

      INSERT INTO public.emergency_contacts
        (user_id, name, relationship, phone, notification_method, whatsapp_consent_at)
      VALUES
        (NEW.id, trim(contact->>'name'), trim(contact->>'relationship'), phone, 'WHATSAPP', now());
    END LOOP;
  END IF;

  -- Emergency contact data lives in its protected table, not in Auth user metadata.
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'emergency_contacts' - 'whatsapp_alerts_consent'
    WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

-- Queue one WhatsApp SOS template for each of the user's two opted-in contacts.
CREATE OR REPLACE FUNCTION public.enqueue_sos_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected_name text;
  location_text text := 'Ubicación no disponible';
  contact record;
BEGIN
  SELECT p.full_name INTO affected_name FROM public.profiles p WHERE p.id = NEW.user_id;

  IF NEW.trip_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.ride_companions rc
    JOIN public.trip_requests tr ON tr.id = rc.trip_request_id
    WHERE tr.trip_id = NEW.trip_id AND rc.student_id = NEW.user_id
      AND rc.consent_at IS NOT NULL AND rc.revoked_at IS NULL AND rc.closed_at IS NULL
      AND rc.expires_at > now()
  ) THEN
    SELECT 'https://www.google.com/maps?q=' || r.latitude::text || ',' || r.longitude::text
      INTO location_text
    FROM public.ride_trackings r
    WHERE r.trip_id = NEW.trip_id AND r.recorded_by = NEW.user_id
    ORDER BY r.recorded_at DESC LIMIT 1;
    location_text := coalesce(location_text, 'Ubicación no disponible');
  END IF;

  FOR contact IN
    SELECT ec.id, ec.phone, ec.name
    FROM public.emergency_contacts ec
    JOIN public.profiles p ON p.id = ec.user_id
    WHERE ec.user_id = NEW.user_id AND ec.notification_method = 'WHATSAPP'
      AND ec.whatsapp_consent_at IS NOT NULL AND p.whatsapp_alerts_consent_at IS NOT NULL
  LOOP
    INSERT INTO public.whatsapp_messages
      (dedupe_key, owner_id, contact_id, sos_alert_id, purpose, recipient_phone, template_name, template_parameters)
    VALUES
      ('SOS_ALERT:' || NEW.id::text || ':' || contact.id::text,
       NEW.user_id, contact.id, NEW.id, 'SOS_ALERT', contact.phone,
       'studentgo_sos_alert_v1',
       jsonb_build_array(contact.name, coalesce(affected_name, 'Usuario Student Go'),
         to_char(NEW.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD HH24:MI'), location_text))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_sos_whatsapp ON public.sos_alerts;
CREATE TRIGGER trg_enqueue_sos_whatsapp
AFTER INSERT ON public.sos_alerts
FOR EACH ROW EXECUTE FUNCTION public.enqueue_sos_whatsapp();
REVOKE EXECUTE ON FUNCTION public.enqueue_sos_whatsapp() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_student_profile() FROM PUBLIC, anon, authenticated;

-- Reminder messages are external WhatsApp templates; internal in-app notice stays enabled.
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
  contact_name text;
  student_name text;
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
    SELECT rc.id, rc.student_id, rc.trip_request_id, rc.name, rc.phone, ec.id AS contact_id
    FROM public.ride_companions rc
    JOIN public.trip_requests tr ON tr.id = rc.trip_request_id
    JOIN public.profiles p ON p.id = rc.student_id
    LEFT JOIN public.emergency_contacts ec ON ec.user_id = rc.student_id AND ec.phone = rc.phone
    WHERE tr.trip_completed_at IS NOT NULL AND tr.arrival_deadline_at <= now()
      AND rc.arrival_response IS NULL AND rc.revoked_at IS NULL AND rc.closed_at IS NULL
      AND rc.expires_at > now() AND rc.last_reminder_at IS NULL
      AND rc.whatsapp_consent_at IS NOT NULL
      AND p.whatsapp_alerts_consent_at IS NOT NULL
  LOOP
    contact_name := c.name;
    SELECT full_name INTO student_name FROM public.profiles WHERE id = c.student_id;
    INSERT INTO public.whatsapp_messages
      (dedupe_key, owner_id, contact_id, companion_id, trip_request_id, purpose, recipient_phone, template_name, template_parameters)
    VALUES
      ('ARRIVAL_REMINDER:' || c.id::text, c.student_id, c.contact_id, c.id, c.trip_request_id,
       'ARRIVAL_REMINDER', c.phone, 'studentgo_arrival_reminder_v1',
       jsonb_build_array(contact_name, coalesce(student_name, 'Estudiante')))
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

CREATE OR REPLACE FUNCTION public.enqueue_arrival_confirmation_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE c record; actor_name text;
BEGIN
  IF OLD.trip_completed_at IS NOT NULL OR NEW.trip_completed_at IS NULL THEN RETURN NEW; END IF;
  FOR c IN
    SELECT rc.id, rc.student_id, rc.name, rc.phone, ec.id AS contact_id
    FROM public.ride_companions rc
    JOIN public.profiles p ON p.id = rc.student_id
    LEFT JOIN public.emergency_contacts ec ON ec.user_id = rc.student_id AND ec.phone = rc.phone
    WHERE rc.trip_request_id = NEW.id AND rc.token_ciphertext IS NOT NULL
      AND rc.consent_at IS NOT NULL AND rc.whatsapp_consent_at IS NOT NULL
      AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now()
      AND p.whatsapp_alerts_consent_at IS NOT NULL
  LOOP
    SELECT full_name INTO actor_name FROM public.profiles WHERE id = c.student_id;
    INSERT INTO public.whatsapp_messages
      (dedupe_key, owner_id, contact_id, companion_id, trip_request_id, purpose, recipient_phone, template_name, template_parameters)
    VALUES
      ('ARRIVAL_CONFIRMATION:' || c.id::text, c.student_id, c.contact_id, c.id, NEW.id,
       'ARRIVAL_CONFIRMATION', c.phone, 'studentgo_arrival_confirmation_v1',
       jsonb_build_array(c.name, coalesce(actor_name, 'Estudiante')))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_arrival_confirmation_whatsapp ON public.trip_requests;
CREATE TRIGGER trg_enqueue_arrival_confirmation_whatsapp
AFTER UPDATE OF trip_completed_at ON public.trip_requests
FOR EACH ROW EXECUTE FUNCTION public.enqueue_arrival_confirmation_whatsapp();
REVOKE EXECUTE ON FUNCTION public.enqueue_arrival_confirmation_whatsapp() FROM PUBLIC, anon, authenticated;

-- A passenger or the trip's driver may independently share their own journey.
DROP FUNCTION IF EXISTS public.create_ride_companion(uuid, text, text, text, text, boolean);
CREATE OR REPLACE FUNCTION public.create_ride_companion(
  p_trip_request_id uuid, p_name text, p_relationship text, p_phone text,
  p_source text, p_consent boolean, p_whatsapp_consent boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  req record;
  actor_role text;
  active_count integer;
  tok text;
  new_id uuid;
  normalized_phone text := regexp_replace(coalesce(p_phone, ''), '[ ()-]', '', 'g');
  exp timestamptz := now() + interval '12 hours';
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'NO_AUTENTICADO'); END IF;
  IF p_consent IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_REQUERIDO'); END IF;
  IF p_whatsapp_consent IS NOT TRUE THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_WHATSAPP_REQUERIDO'); END IF;
  IF p_source NOT IN ('COMPANION', 'EMERGENCY_CONTACT') THEN RETURN jsonb_build_object('ok', false, 'reason', 'FUENTE_INVALIDA'); END IF;
  IF char_length(trim(coalesce(p_name, ''))) NOT BETWEEN 2 AND 100 THEN RETURN jsonb_build_object('ok', false, 'reason', 'NOMBRE_INVALIDO'); END IF;
  IF char_length(trim(coalesce(p_relationship, ''))) NOT BETWEEN 2 AND 60 THEN RETURN jsonb_build_object('ok', false, 'reason', 'RELACION_INVALIDA'); END IF;
  IF normalized_phone !~ '^\+[1-9][0-9]{9,14}$' THEN RETURN jsonb_build_object('ok', false, 'reason', 'TELEFONO_INVALIDO'); END IF;

  SELECT q.id, q.trip_id, q.status, q.trip_started_at, q.passenger_id,
         t.driver_id, t.status AS trip_status
  INTO req
  FROM public.trip_requests q JOIN public.trips t ON t.id = q.trip_id
  WHERE q.id = p_trip_request_id
    AND (q.passenger_id = auth.uid() OR t.driver_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;
  IF req.status <> 'ACCEPTED' OR req.trip_started_at IS NULL OR req.trip_status <> 'IN_PROGRESS' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_NO_EN_CURSO');
  END IF;
  actor_role := CASE WHEN req.passenger_id = auth.uid() THEN 'STUDENT' ELSE 'DRIVER' END;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.whatsapp_alerts_consent_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_WHATSAPP_REQUERIDO');
  END IF;

  IF p_source = 'EMERGENCY_CONTACT' AND NOT EXISTS (
    SELECT 1 FROM public.emergency_contacts ec
    WHERE ec.user_id = auth.uid() AND ec.phone = normalized_phone
      AND ec.notification_method = 'WHATSAPP' AND ec.whatsapp_consent_at IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'CONTACTO_WHATSAPP_NO_AUTORIZADO');
  END IF;

  SELECT count(*) INTO active_count
  FROM public.ride_companions rc
  JOIN public.trip_requests rq ON rq.id = rc.trip_request_id
  WHERE rq.trip_id = req.trip_id AND rc.student_id = auth.uid()
    AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now();
  IF active_count >= 3 THEN RETURN jsonb_build_object('ok', false, 'reason', 'LIMITE_ALCANZADO'); END IF;

  tok := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  INSERT INTO public.ride_companions
    (trip_request_id, student_id, actor_role, name, relationship, phone, source, token_hash, expires_at, whatsapp_consent_at)
  VALUES
    (p_trip_request_id, auth.uid(), actor_role, trim(p_name), trim(p_relationship), normalized_phone,
     p_source, encode(extensions.digest(tok, 'sha256'), 'hex'), exp, now())
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'companion_id', new_id, 'token', tok, 'expires_at', exp);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_companion_location(
  p_trip_request_id uuid, p_latitude double precision, p_longitude double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE trip_uuid uuid;
BEGIN
  IF auth.uid() IS NULL OR p_latitude IS NULL OR p_longitude IS NULL
    OR p_latitude NOT BETWEEN -90 AND 90 OR p_longitude NOT BETWEEN -180 AND 180 THEN
    RETURN false;
  END IF;

  SELECT q.trip_id INTO trip_uuid
  FROM public.trip_requests q JOIN public.trips t ON t.id = q.trip_id
  WHERE q.id = p_trip_request_id AND q.status = 'ACCEPTED'
    AND q.trip_started_at IS NOT NULL AND q.trip_completed_at IS NULL
    AND t.status = 'IN_PROGRESS'
    AND EXISTS (
      SELECT 1 FROM public.ride_companions rc
      WHERE rc.trip_request_id = q.id AND rc.student_id = auth.uid()
        AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now()
    );
  IF trip_uuid IS NULL THEN RETURN false; END IF;
  INSERT INTO public.ride_trackings (trip_id, recorded_by, latitude, longitude, recorded_at)
  VALUES (trip_uuid, auth.uid(), p_latitude, p_longitude, now());
  RETURN true;
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
  IF p_response NOT IN ('ARRIVED', 'NOT_ARRIVED', 'CANNOT_CONFIRM') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'RESPUESTA_INVALIDA');
  END IF;
  SELECT rc.id, rc.name, rc.relationship, rc.student_id, rc.actor_role, rc.revoked_at,
         rc.closed_at, rc.expires_at, rc.arrival_response, q.trip_id, q.trip_completed_at
  INTO c
  FROM public.ride_companions rc JOIN public.trip_requests q ON q.id = rc.trip_request_id
  WHERE rc.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_NO_VALIDO'); END IF;
  IF c.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_REVOCADO'); END IF;
  IF c.closed_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'ACOMPANAMIENTO_FINALIZADO'); END IF;
  IF c.expires_at <= now() THEN RETURN jsonb_build_object('ok', false, 'reason', 'ENLACE_EXPIRADO'); END IF;
  IF c.trip_completed_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_EN_CURSO'); END IF;
  IF c.arrival_response = 'NOT_ARRIVED' AND p_response = 'NOT_ARRIVED' THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'YA_REGISTRADO');
  END IF;
  IF p_response = 'NOT_ARRIVED' THEN
    SELECT r.latitude, r.longitude INTO lat, lng FROM public.ride_trackings r
    WHERE r.trip_id = c.trip_id AND r.recorded_by = c.student_id
    ORDER BY r.recorded_at DESC LIMIT 1;
    INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status, auto_triggered)
    VALUES (c.student_id, c.trip_id, c.actor_role, lat, lng,
      'Acompañante ' || c.name || ' (' || c.relationship || ') reportó que el usuario NO HA LLEGADO.',
      'ACTIVE', false) RETURNING id INTO new_sos;
  END IF;
  UPDATE public.ride_companions SET arrival_response = p_response, arrival_responded_at = now(),
    closed_at = CASE WHEN p_response = 'ARRIVED' THEN now() ELSE closed_at END,
    sos_alert_id = coalesce(new_sos, sos_alert_id) WHERE id = c.id;
  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'response', p_response, 'sos_alert_id', new_sos);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.record_companion_location(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_companion_location(uuid, double precision, double precision) TO authenticated;

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
  SELECT rc.id, rc.student_id, rc.name, rc.expires_at, rc.revoked_at, rc.closed_at,
         rc.arrival_response, rc.arrival_responded_at, q.trip_id, q.passenger_confirmed_at,
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
    'companion_name', c.name, 'expires_at', c.expires_at,
    'origin', c.origin_text, 'destination', c.destination_text,
    'departure_at', c.departure_at, 'trip_status', c.trip_status,
    'trip_started', c.trip_started_at IS NOT NULL,
    'trip_completed', c.trip_completed_at IS NOT NULL,
    'student_confirmed_at', c.passenger_confirmed_at,
    'companion_response', c.arrival_response,
    'companion_responded_at', c.arrival_responded_at,
    'latitude', lat, 'longitude', lng, 'location_at', loc_at
  );
END;
$$;
