-- Acompanamiento Inteligente is opt-in independently for every participant and trip.
-- QR boarding and SOS stay separate flows. This migration never enables sharing by default.

CREATE TABLE IF NOT EXISTS public.trip_companionship_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  selection text NOT NULL CHECK (selection IN ('EMERGENCY_CONTACTS', 'WAITING_PERSON', 'BOTH', 'NOW_NOT')),
  active boolean NOT NULL DEFAULT false,
  location_consent_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, user_id),
  CHECK ((active AND selection <> 'NOW_NOT' AND location_consent_at IS NOT NULL AND disabled_at IS NULL)
      OR (NOT active AND selection = 'NOW_NOT'))
);

ALTER TABLE public.trip_companionship_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trip_companionship_preferences FROM anon, authenticated;
GRANT SELECT ON public.trip_companionship_preferences TO authenticated;
CREATE POLICY trip_companionship_preferences_select_own
  ON public.trip_companionship_preferences FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.set_trip_companionship_preference(
  p_trip_id uuid,
  p_selection text,
  p_location_consent boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  can_participate boolean;
  wants_active boolean;
BEGIN
  IF auth.uid() IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'NO_AUTENTICADO'); END IF;
  IF p_selection NOT IN ('EMERGENCY_CONTACTS', 'WAITING_PERSON', 'BOTH', 'NOW_NOT') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'OPCION_INVALIDA');
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.trips t
    WHERE t.id = p_trip_id AND t.status = 'IN_PROGRESS'
      AND (t.driver_id = auth.uid() OR EXISTS (
        SELECT 1 FROM public.trip_requests q
        WHERE q.trip_id = t.id AND q.passenger_id = auth.uid() AND q.status = 'ACCEPTED' AND q.trip_started_at IS NOT NULL
      ))
  ) INTO can_participate;
  IF NOT can_participate THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_NO_EN_CURSO'); END IF;

  wants_active := p_selection <> 'NOW_NOT';
  IF wants_active AND p_location_consent IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_REQUERIDO');
  END IF;

  INSERT INTO public.trip_companionship_preferences
    (trip_id, user_id, selection, active, location_consent_at, disabled_at)
  VALUES
    (p_trip_id, auth.uid(), p_selection, wants_active,
     CASE WHEN wants_active THEN now() ELSE NULL END,
     CASE WHEN wants_active THEN NULL ELSE now() END)
  ON CONFLICT (trip_id, user_id) DO UPDATE SET
    selection = EXCLUDED.selection,
    active = EXCLUDED.active,
    location_consent_at = EXCLUDED.location_consent_at,
    disabled_at = EXCLUDED.disabled_at,
    updated_at = now();

  IF NOT wants_active THEN
    UPDATE public.ride_companions rc SET revoked_at = now()
    FROM public.trip_requests q
    WHERE rc.trip_request_id = q.id AND q.trip_id = p_trip_id AND rc.student_id = auth.uid()
      AND rc.revoked_at IS NULL AND rc.closed_at IS NULL;
  END IF;
  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'active', wants_active);
END;
$$;

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

  SELECT q.id, q.trip_id, q.status, q.trip_started_at, q.passenger_id, t.driver_id, t.status AS trip_status
  INTO req FROM public.trip_requests q JOIN public.trips t ON t.id = q.trip_id
  WHERE q.id = p_trip_request_id AND (q.passenger_id = auth.uid() OR t.driver_id = auth.uid());
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'SOLICITUD_NO_ENCONTRADA'); END IF;
  IF req.status <> 'ACCEPTED' OR req.trip_started_at IS NULL OR req.trip_status <> 'IN_PROGRESS' THEN RETURN jsonb_build_object('ok', false, 'reason', 'VIAJE_NO_EN_CURSO'); END IF;
  actor_role := CASE WHEN req.passenger_id = auth.uid() THEN 'STUDENT' ELSE 'DRIVER' END;

  IF NOT EXISTS (SELECT 1 FROM public.trip_companionship_preferences p
    WHERE p.trip_id = req.trip_id AND p.user_id = auth.uid() AND p.active AND p.location_consent_at IS NOT NULL
      AND ((p.selection IN ('EMERGENCY_CONTACTS', 'BOTH') AND p_source = 'EMERGENCY_CONTACT')
        OR (p.selection IN ('WAITING_PERSON', 'BOTH') AND p_source = 'COMPANION')))
  THEN RETURN jsonb_build_object('ok', false, 'reason', 'ACOMPAÑAMIENTO_NO_ACTIVADO'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.whatsapp_alerts_consent_at IS NOT NULL) THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONSENTIMIENTO_WHATSAPP_REQUERIDO'); END IF;
  IF p_source = 'EMERGENCY_CONTACT' AND NOT EXISTS (SELECT 1 FROM public.emergency_contacts ec
    WHERE ec.user_id = auth.uid() AND ec.phone = normalized_phone AND ec.notification_method = 'WHATSAPP' AND ec.whatsapp_consent_at IS NOT NULL)
  THEN RETURN jsonb_build_object('ok', false, 'reason', 'CONTACTO_WHATSAPP_NO_AUTORIZADO'); END IF;

  SELECT count(*) INTO active_count FROM public.ride_companions rc JOIN public.trip_requests rq ON rq.id = rc.trip_request_id
  WHERE rq.trip_id = req.trip_id AND rc.student_id = auth.uid() AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now();
  IF active_count >= 3 THEN RETURN jsonb_build_object('ok', false, 'reason', 'LIMITE_ALCANZADO'); END IF;
  tok := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  INSERT INTO public.ride_companions (trip_request_id, student_id, actor_role, name, relationship, phone, source, token_hash, expires_at, whatsapp_consent_at)
  VALUES (p_trip_request_id, auth.uid(), actor_role, trim(p_name), trim(p_relationship), normalized_phone, p_source,
    encode(extensions.digest(tok, 'sha256'), 'hex'), exp, now()) RETURNING id INTO new_id;
  RETURN jsonb_build_object('ok', true, 'reason', 'OK', 'companion_id', new_id, 'token', tok, 'expires_at', exp);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_trip_companionship_preference(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_trip_companionship_preference(uuid, text, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_ride_companion(uuid, text, text, text, text, boolean, boolean) TO authenticated;
