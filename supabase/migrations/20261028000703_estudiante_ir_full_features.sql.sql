/*
# Estudiante Ir: innovaciones reales (QR, biometría, SOS, tarifa, seguimiento, contactos)
1. Nuevas tablas para contactos de emergencia, alertas SOS, credenciales biométricas,
   seguimiento de viaje y configuración de tarifa.
2. QR: token firmado y de un solo uso por solicitud, validado por función RPC atómica.
3. RLS estricta: cada usuario solo accede a sus propias filas; el seguimiento lo leen
   los participantes del viaje.
4. Tarifa: configuración central con base, precio por km y por minuto.
*/

CREATE TABLE IF NOT EXISTS public.emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sos_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('STUDENT','DRIVER')),
  latitude double precision,
  longitude double precision,
  message text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.biometric_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ride_trackings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  recorded_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  latitude double precision NOT NULL,
  longitude double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fare_config (
  id integer PRIMARY KEY DEFAULT 1,
  base_fare numeric(8,2) NOT NULL DEFAULT 10,
  per_km numeric(8,2) NOT NULL DEFAULT 2.5,
  per_minute numeric(8,2) NOT NULL DEFAULT 0.8,
  min_fare numeric(8,2) NOT NULL DEFAULT 15,
  CONSTRAINT fare_config_singleton CHECK (id = 1)
);
INSERT INTO public.fare_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.trip_requests
  ADD COLUMN IF NOT EXISTS qr_token text,
  ADD COLUMN IF NOT EXISTS qr_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS qr_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS trip_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS trip_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS passenger_confirmed_at timestamptz;

CREATE INDEX IF NOT EXISTS emergency_contacts_user_idx ON public.emergency_contacts (user_id);
CREATE INDEX IF NOT EXISTS sos_alerts_user_idx ON public.sos_alerts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ride_trackings_trip_idx ON public.ride_trackings (trip_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS trip_requests_qr_idx ON public.trip_requests (qr_token);

ALTER TABLE public.emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sos_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.biometric_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ride_trackings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fare_config ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.emergency_contacts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sos_alerts TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.biometric_credentials TO authenticated;
GRANT SELECT, INSERT ON public.ride_trackings TO authenticated;
GRANT SELECT ON public.fare_config TO authenticated;

DROP POLICY IF EXISTS "emergency_contacts_own" ON public.emergency_contacts;
CREATE POLICY "emergency_contacts_select_own" ON public.emergency_contacts FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "emergency_contacts_insert_own" ON public.emergency_contacts FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "emergency_contacts_update_own" ON public.emergency_contacts FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "emergency_contacts_delete_own" ON public.emergency_contacts FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "sos_alerts_own" ON public.sos_alerts;
CREATE POLICY "sos_alerts_select_own" ON public.sos_alerts FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "sos_alerts_insert_own" ON public.sos_alerts FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "sos_alerts_update_own" ON public.sos_alerts FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "biometric_own" ON public.biometric_credentials;
CREATE POLICY "biometric_select_own" ON public.biometric_credentials FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "biometric_insert_own" ON public.biometric_credentials FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "biometric_delete_own" ON public.biometric_credentials FOR DELETE TO authenticated USING (user_id = auth.uid());

CREATE POLICY "ride_trackings_select_participant" ON public.ride_trackings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trips t WHERE t.id = trip_id AND (t.driver_id = auth.uid() OR EXISTS (SELECT 1 FROM public.trip_requests r WHERE r.trip_id = ride_trackings.trip_id AND r.passenger_id = auth.uid()))));
CREATE POLICY "ride_trackings_insert_driver" ON public.ride_trackings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.trips t WHERE t.id = trip_id AND t.driver_id = auth.uid()));

CREATE POLICY "fare_config_select" ON public.fare_config FOR SELECT TO authenticated USING (true);

-- Permite al conductor actualizar el estado de la solicitud (aceptar/rechazar/iniciar/finalizar)
DROP POLICY IF EXISTS "requests_update_driver" ON public.trip_requests;
CREATE POLICY "requests_update_driver" ON public.trip_requests FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trips t WHERE t.id = trip_requests.trip_id AND t.driver_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.trips t WHERE t.id = trip_requests.trip_id AND t.driver_id = auth.uid()));

-- Permite al pasajero actualizar su confirmación de llegada y cancelar
DROP POLICY IF EXISTS "requests_update_passenger" ON public.trip_requests;
CREATE POLICY "requests_update_passenger" ON public.trip_requests FOR UPDATE TO authenticated
  USING (passenger_id = auth.uid()) WITH CHECK (passenger_id = auth.uid());

GRANT UPDATE ON public.trip_requests TO authenticated;

-- Función atómica para validar el QR del pasajero (un solo uso)
CREATE OR REPLACE FUNCTION public.validate_ride_qr(token_input text)
RETURNS TABLE (valid boolean, request_id uuid, trip_id uuid, passenger_id uuid, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  req public.trip_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM public.trip_requests WHERE qr_token = token_input;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'TOKEN_NO_ENCONTRADO';
    RETURN;
  END IF;
  IF req.qr_used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_YA_USADO';
    RETURN;
  END IF;
  IF req.status NOT IN ('ACCEPTED') THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'SOLICITUD_NO_ACEPTADA';
    RETURN;
  END IF;
  IF req.qr_issued_at + interval '2 hours' < now() THEN
    RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, NULL::uuid, 'QR_EXPIRADO';
    RETURN;
  END IF;
  UPDATE public.trip_requests
    SET qr_used_at = now(), trip_started_at = now(), status = 'COMPLETED'
    WHERE id = req.id;
  UPDATE public.trips SET status = 'IN_PROGRESS' WHERE id = req.trip_id AND status IN ('PUBLISHED','FULL');
  RETURN QUERY SELECT true, req.id, req.trip_id, req.passenger_id, 'OK';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.validate_ride_qr(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_ride_qr(text) TO authenticated;

-- Función para aceptar solicitud: emite el QR firmado
CREATE OR REPLACE FUNCTION public.accept_ride_request(request_id uuid)
RETURNS TABLE (ok boolean, qr_token text, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  req public.trip_requests%ROWTYPE;
  trip_row public.trips%ROWTYPE;
  new_token text;
BEGIN
  SELECT * INTO req FROM public.trip_requests WHERE id = request_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, NULL::text, 'SOLICITUD_NO_EXISTE'; RETURN; END IF;
  SELECT * INTO trip_row FROM public.trips WHERE id = req.trip_id;
  IF trip_row.driver_id <> auth.uid() THEN RETURN QUERY SELECT false, NULL::text, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF req.status <> 'PENDING' THEN RETURN QUERY SELECT false, NULL::text, 'YA_PROCESADA'; RETURN; END IF;
  new_token := encode(gen_random_bytes(24), 'hex') || '-' || request_id::text;
  UPDATE public.trip_requests
    SET status = 'ACCEPTED', accepted_at = now(), qr_token = new_token, qr_issued_at = now()
    WHERE id = request_id;
  RETURN QUERY SELECT true, new_token, 'OK';
END;
$$;
REVOKE EXECUTE ON FUNCTION public.accept_ride_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_ride_request(uuid) TO authenticated;
