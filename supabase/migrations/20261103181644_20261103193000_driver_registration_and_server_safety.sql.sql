/*
# Registro seguro de conductores y acompañamiento persistente

1. Nuevas tablas
- `driver_applications`: solicitud del estudiante con estado, motivo y auditoría administrativa.
- `vehicles`: vehículo asociado, datos de identificación y vigencias documentales.

2. Cambios existentes
- `trips.vehicle_id` relaciona el viaje con un vehículo aprobado.
- `trip_requests.arrival_deadline_at` guarda el límite de confirmación.
- Índice único para impedir SOS automáticos duplicados por viaje.

3. Seguridad
- RLS limita solicitudes y vehículos al propietario o administrador.
- Los documentos permanecen en `student-documents`, un bucket privado.
- La publicación y revisión se validan en funciones protegidas del servidor.

4. Acompañamiento persistente
- La llegada guarda un plazo de 10 minutos.
- El procesador de vencimientos revisa todos los pasajeros y es idempotente.
- `pg_cron` ejecuta la revisión cada minuto cuando está habilitado.

5. Notas
- No se eliminan columnas ni registros existentes.
- Sin administrador, las solicitudes permanecen pendientes.
*/

CREATE TABLE IF NOT EXISTS public.driver_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'INCOMPLETE' CHECK (status IN ('INCOMPLETE','PENDING_REVIEW','APPROVED','REJECTED')),
  rejection_reason text, submitted_at timestamptz, approved_at timestamptz, approved_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id)
);
CREATE TABLE IF NOT EXISTS public.vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL REFERENCES public.driver_applications(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  brand text NOT NULL, model text NOT NULL, vehicle_year integer NOT NULL CHECK (vehicle_year BETWEEN 1950 AND 2100), color text NOT NULL,
  plates text NOT NULL, passenger_capacity integer NOT NULL CHECK (passenger_capacity BETWEEN 1 AND 8), license_path text NOT NULL,
  registration_card_path text NOT NULL, license_expires_at date NOT NULL, registration_expires_at date NOT NULL,
  status text NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_plates_lower_key ON public.vehicles (lower(plates));
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE RESTRICT;
ALTER TABLE public.trip_requests ADD COLUMN IF NOT EXISTS arrival_deadline_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS sos_auto_trip_unique ON public.sos_alerts (trip_id) WHERE auto_triggered = true AND trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS driver_applications_status_idx ON public.driver_applications (status, submitted_at);
CREATE INDEX IF NOT EXISTS vehicles_owner_status_idx ON public.vehicles (owner_id, status);
CREATE INDEX IF NOT EXISTS trip_requests_arrival_deadline_idx ON public.trip_requests (arrival_deadline_at) WHERE arrival_deadline_at IS NOT NULL AND passenger_confirmed_at IS NULL;

ALTER TABLE public.driver_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.driver_applications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vehicles TO authenticated;

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth
AS $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'ADMIN'); $$;
REVOKE EXECUTE ON FUNCTION public.is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

DROP POLICY IF EXISTS "driver_applications_select_owner_or_admin" ON public.driver_applications;
CREATE POLICY "driver_applications_select_owner_or_admin" ON public.driver_applications FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS "driver_applications_insert_owner" ON public.driver_applications;
CREATE POLICY "driver_applications_insert_owner" ON public.driver_applications FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "driver_applications_update_owner_pending" ON public.driver_applications;
CREATE POLICY "driver_applications_update_owner_pending" ON public.driver_applications FOR UPDATE TO authenticated USING (user_id = auth.uid() AND status IN ('INCOMPLETE','REJECTED')) WITH CHECK (user_id = auth.uid() AND status IN ('INCOMPLETE','PENDING_REVIEW','REJECTED'));
DROP POLICY IF EXISTS "driver_applications_update_admin" ON public.driver_applications;
CREATE POLICY "driver_applications_update_admin" ON public.driver_applications FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "vehicles_select_owner_or_admin" ON public.vehicles;
CREATE POLICY "vehicles_select_owner_or_admin" ON public.vehicles FOR SELECT TO authenticated USING (owner_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS "vehicles_insert_owner" ON public.vehicles;
CREATE POLICY "vehicles_insert_owner" ON public.vehicles FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid() AND EXISTS (SELECT 1 FROM public.driver_applications a WHERE a.id = application_id AND a.user_id = auth.uid()));
DROP POLICY IF EXISTS "vehicles_update_owner_pending" ON public.vehicles;
CREATE POLICY "vehicles_update_owner_pending" ON public.vehicles FOR UPDATE TO authenticated USING (owner_id = auth.uid() AND status IN ('PENDING_REVIEW','REJECTED')) WITH CHECK (owner_id = auth.uid() AND status IN ('PENDING_REVIEW','REJECTED'));
DROP POLICY IF EXISTS "vehicles_update_admin" ON public.vehicles;
CREATE POLICY "vehicles_update_admin" ON public.vehicles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE OR REPLACE FUNCTION public.submit_driver_application(p_brand text, p_model text, p_year integer, p_color text, p_plates text, p_capacity integer, p_license_path text, p_registration_card_path text, p_license_expires_at date, p_registration_expires_at date)
RETURNS TABLE(ok boolean, application_id uuid, vehicle_id uuid, reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE app_id uuid; vehicle_id_out uuid; uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'NO_AUTENTICADO'; RETURN; END IF;
  IF length(btrim(coalesce(p_brand,''))) < 2 OR length(btrim(coalesce(p_model,''))) < 1 OR length(btrim(coalesce(p_color,''))) < 2 THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DATOS_INCOMPLETOS'; RETURN; END IF;
  IF p_plates !~ '^[A-Z0-9 -]{5,10}$' OR p_year < 1950 OR p_year > extract(year from now())::integer + 1 OR p_capacity < 1 OR p_capacity > 8 THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'VEHICULO_INVALIDO'; RETURN; END IF;
  IF p_license_expires_at < current_date OR p_registration_expires_at < current_date THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DOCUMENTO_VENCIDO'; RETURN; END IF;
  IF p_license_path !~ ('^' || uid::text || '/') OR p_registration_card_path !~ ('^' || uid::text || '/') THEN RETURN QUERY SELECT false, NULL::uuid, NULL::uuid, 'DOCUMENTO_INVALIDO'; RETURN; END IF;
  INSERT INTO public.driver_applications (user_id, status, submitted_at, updated_at) VALUES (uid, 'PENDING_REVIEW', now(), now()) ON CONFLICT (user_id) DO UPDATE SET status = 'PENDING_REVIEW', rejection_reason = NULL, submitted_at = now(), approved_at = NULL, approved_by = NULL, updated_at = now() RETURNING id INTO app_id;
  INSERT INTO public.vehicles (application_id, owner_id, brand, model, vehicle_year, color, plates, passenger_capacity, license_path, registration_card_path, license_expires_at, registration_expires_at, status)
  VALUES (app_id, uid, btrim(p_brand), btrim(p_model), p_year, btrim(p_color), upper(btrim(p_plates)), p_capacity, p_license_path, p_registration_card_path, p_license_expires_at, p_registration_expires_at, 'PENDING_REVIEW')
  ON CONFLICT (lower(plates)) DO UPDATE SET application_id = EXCLUDED.application_id, brand = EXCLUDED.brand, model = EXCLUDED.model, vehicle_year = EXCLUDED.vehicle_year, color = EXCLUDED.color, passenger_capacity = EXCLUDED.passenger_capacity, license_path = EXCLUDED.license_path, registration_card_path = EXCLUDED.registration_card_path, license_expires_at = EXCLUDED.license_expires_at, registration_expires_at = EXCLUDED.registration_expires_at, status = 'PENDING_REVIEW', updated_at = now()
  RETURNING id INTO vehicle_id_out;
  RETURN QUERY SELECT true, app_id, vehicle_id_out, 'PENDING_REVIEW';
END; $$;
REVOKE EXECUTE ON FUNCTION public.submit_driver_application(text,text,integer,text,text,integer,text,text,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_driver_application(text,text,integer,text,text,integer,text,text,date,date) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_driver_application(p_application_id uuid, p_approved boolean, p_reason text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE next_status text; target_user uuid;
BEGIN
  IF NOT public.is_admin() THEN RETURN QUERY SELECT false, 'NO_AUTORIZADO'; RETURN; END IF;
  SELECT user_id INTO target_user FROM public.driver_applications WHERE id = p_application_id AND status = 'PENDING_REVIEW';
  IF target_user IS NULL THEN RETURN QUERY SELECT false, 'SOLICITUD_NO_DISPONIBLE'; RETURN; END IF;
  next_status := CASE WHEN p_approved THEN 'APPROVED' ELSE 'REJECTED' END;
  UPDATE public.driver_applications SET status = next_status, rejection_reason = CASE WHEN p_approved THEN NULL ELSE left(btrim(coalesce(p_reason,'')), 500) END, approved_at = CASE WHEN p_approved THEN now() ELSE NULL END, approved_by = CASE WHEN p_approved THEN auth.uid() ELSE NULL END, updated_at = now() WHERE id = p_application_id;
  UPDATE public.vehicles SET status = next_status, updated_at = now() WHERE application_id = p_application_id;
  UPDATE public.profiles SET role = CASE WHEN p_approved THEN 'DRIVER' ELSE role END, driver_verified = p_approved, updated_at = now() WHERE id = target_user;
  RETURN QUERY SELECT true, next_status;
END; $$;
REVOKE EXECUTE ON FUNCTION public.review_driver_application(uuid,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_driver_application(uuid,boolean,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.publish_trip_with_vehicle(p_vehicle_id uuid, p_origin_text text, p_destination_text text, p_origin_lat double precision, p_origin_lng double precision, p_destination_lat double precision, p_destination_lng double precision, p_departure_at timestamptz, p_available_seats integer, p_distance_km numeric, p_estimated_minutes integer, p_suggested_fare numeric, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE result_id uuid; vehicle_row public.vehicles%ROWTYPE;
BEGIN
  SELECT v.* INTO vehicle_row FROM public.vehicles v JOIN public.driver_applications a ON a.id = v.application_id WHERE v.id = p_vehicle_id AND v.owner_id = auth.uid() AND v.status = 'APPROVED' AND a.status = 'APPROVED' AND v.license_expires_at >= current_date AND v.registration_expires_at >= current_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICULO_NO_APROBADO'; END IF;
  IF p_available_seats < 1 OR p_available_seats > vehicle_row.passenger_capacity OR p_departure_at <= now() THEN RAISE EXCEPTION 'DATOS_VIAJE_INVALIDOS'; END IF;
  INSERT INTO public.trips (driver_id, vehicle_id, origin_text, destination_text, origin_lat, origin_lng, destination_lat, destination_lng, departure_at, meeting_point, distance_km, estimated_minutes, available_seats, suggested_fare, vehicle_name, notes, status)
  VALUES (auth.uid(), p_vehicle_id, btrim(p_origin_text), btrim(p_destination_text), p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_departure_at, btrim(p_origin_text), p_distance_km, p_estimated_minutes, p_available_seats, p_suggested_fare, vehicle_row.brand || ' ' || vehicle_row.model, p_notes, 'PUBLISHED') RETURNING id INTO result_id;
  RETURN result_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.publish_trip_with_vehicle(uuid,text,text,double precision,double precision,double precision,double precision,timestamptz,integer,numeric,integer,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_trip_with_vehicle(uuid,text,text,double precision,double precision,double precision,double precision,timestamptz,integer,numeric,integer,numeric,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE trip_row public.trips%ROWTYPE; deadline timestamptz;
BEGIN
  SELECT * INTO trip_row FROM public.trips WHERE id = trip_uuid AND driver_id = auth.uid();
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status <> 'IN_PROGRESS' THEN RETURN QUERY SELECT false, 'VIAJE_NO_ACTIVO'; RETURN; END IF;
  deadline := now() + interval '10 minutes';
  UPDATE public.trips SET status = 'COMPLETED', updated_at = now() WHERE id = trip_uuid;
  UPDATE public.trip_requests SET trip_completed_at = now(), arrival_deadline_at = deadline WHERE trip_id = trip_uuid AND status = 'ACCEPTED' AND trip_completed_at IS NULL;
  RETURN QUERY SELECT true, 'OK';
END; $$;
REVOKE EXECUTE ON FUNCTION public.complete_ride(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_ride(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.escalate_overdue_arrivals() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE n integer;
BEGIN
  INSERT INTO public.sos_alerts (user_id, trip_id, role, latitude, longitude, message, status, auto_triggered)
  SELECT q.passenger_id, q.trip_id, 'STUDENT', latest.latitude, latest.longitude, 'SOS automático: no se confirmó la llegada dentro del plazo', 'ACTIVE', true
  FROM public.trip_requests q LEFT JOIN LATERAL (SELECT r.latitude, r.longitude FROM public.ride_trackings r WHERE r.trip_id = q.trip_id ORDER BY r.recorded_at DESC LIMIT 1) latest ON true
  WHERE q.status IN ('ACCEPTED','COMPLETED') AND q.arrival_deadline_at IS NOT NULL AND q.arrival_deadline_at <= now() AND q.passenger_confirmed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.sos_alerts s WHERE s.trip_id = q.trip_id AND s.user_id = q.passenger_id AND s.auto_triggered);
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END; $$;
REVOKE EXECUTE ON FUNCTION public.escalate_overdue_arrivals() FROM PUBLIC, anon, authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'student-go-overdue-arrivals';
    PERFORM cron.schedule('student-go-overdue-arrivals', '* * * * *', 'SELECT public.escalate_overdue_arrivals()');
  END IF;
EXCEPTION WHEN undefined_table OR insufficient_privilege THEN NULL;
END $$;

REVOKE ALL ON public.driver_applications FROM anon;
REVOKE ALL ON public.vehicles FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.trips FROM authenticated;
GRANT INSERT (driver_id, vehicle_id, origin_text, destination_text, origin_lat, origin_lng, destination_lat, destination_lng, departure_at, meeting_point, distance_km, estimated_minutes, available_seats, suggested_fare, vehicle_name, notes) ON public.trips TO authenticated;
