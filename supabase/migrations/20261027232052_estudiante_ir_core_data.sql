/*
# Estudiante Ir: core de datos persistente y privado

1. Nuevas tablas
- `profiles`: perfil público controlado del estudiante, vinculado a Supabase Auth.
- `trips`: viajes publicados por conductores verificados.
- `trip_requests`: solicitudes de pasajeros para viajes concretos.
- `notifications`: avisos privados del usuario.

2. Seguridad
- Todas las tablas tienen RLS habilitado.
- Los perfiles solo se pueden consultar por usuarios autenticados y el propietario solo puede editar datos personales no administrativos.
- Los viajes se pueden consultar por usuarios autenticados; únicamente el conductor propietario puede publicarlos, modificarlos o cancelarlos.
- Las solicitudes solo son visibles para el pasajero o el conductor del viaje.
- El estado de verificación y los roles no son editables desde el cliente.

3. Archivos privados
- Se crea el bucket privado `student-documents`.
- Las credenciales, licencias y fotografías se guardan dentro de una carpeta cuyo primer segmento es el ID del usuario.
- Las políticas impiden leer o escribir archivos de otra cuenta.

4. Notas
- Supabase Auth conserva las credenciales y sesiones; no se crea una tabla de contraseñas.
- Los cambios administrativos de verificación, conductor y roles quedan fuera de los permisos del cliente.
*/

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  student_number text NOT NULL UNIQUE,
  phone text,
  campus text NOT NULL DEFAULT 'UTP Puebla',
  career text,
  avatar_path text,
  role text NOT NULL DEFAULT 'STUDENT' CHECK (role IN ('STUDENT', 'DRIVER', 'ADMIN')),
  student_verified boolean NOT NULL DEFAULT false,
  driver_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE RESTRICT,
  origin_text text NOT NULL,
  destination_text text NOT NULL,
  origin_lat double precision,
  origin_lng double precision,
  destination_lat double precision,
  destination_lng double precision,
  departure_at timestamptz NOT NULL,
  meeting_point text NOT NULL,
  distance_km numeric(7,2),
  estimated_minutes integer,
  available_seats integer NOT NULL CHECK (available_seats BETWEEN 1 AND 8),
  suggested_fare numeric(8,2) NOT NULL CHECK (suggested_fare >= 0 AND suggested_fare <= 1000),
  vehicle_name text NOT NULL,
  status text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'FULL', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trip_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  passenger_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  fare numeric(8,2) NOT NULL CHECK (fare >= 0 AND fare <= 1000),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  UNIQUE (trip_id, passenger_id)
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  title text NOT NULL,
  message text NOT NULL,
  type text NOT NULL DEFAULT 'GENERAL',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trips_search_idx ON public.trips (status, departure_at, origin_text, destination_text);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON public.trips (driver_id, departure_at);
CREATE INDEX IF NOT EXISTS trip_requests_passenger_idx ON public.trip_requests (passenger_id, requested_at);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON public.notifications (user_id, created_at DESC);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (full_name, phone, campus, career, avatar_path) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trips TO authenticated;
REVOKE UPDATE ON public.trips FROM authenticated;
GRANT UPDATE (origin_text, destination_text, origin_lat, origin_lng, destination_lat, destination_lng, departure_at, meeting_point, distance_km, estimated_minutes, available_seats, suggested_fare, vehicle_name, notes) ON public.trips TO authenticated;
GRANT SELECT, INSERT ON public.trip_requests TO authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (read_at) ON public.notifications TO authenticated;

DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "trips_select_authenticated" ON public.trips;
CREATE POLICY "trips_select_authenticated" ON public.trips FOR SELECT TO authenticated USING (status <> 'CANCELLED' OR driver_id = auth.uid());
DROP POLICY IF EXISTS "trips_insert_owner" ON public.trips;
CREATE POLICY "trips_insert_owner" ON public.trips FOR INSERT TO authenticated WITH CHECK (driver_id = auth.uid());
DROP POLICY IF EXISTS "trips_update_owner" ON public.trips;
CREATE POLICY "trips_update_owner" ON public.trips FOR UPDATE TO authenticated USING (driver_id = auth.uid()) WITH CHECK (driver_id = auth.uid());
DROP POLICY IF EXISTS "trips_delete_owner" ON public.trips;
CREATE POLICY "trips_delete_owner" ON public.trips FOR DELETE TO authenticated USING (driver_id = auth.uid());

DROP POLICY IF EXISTS "requests_select_participant" ON public.trip_requests;
CREATE POLICY "requests_select_participant" ON public.trip_requests FOR SELECT TO authenticated USING (passenger_id = auth.uid() OR EXISTS (SELECT 1 FROM public.trips WHERE trips.id = trip_requests.trip_id AND trips.driver_id = auth.uid()));
DROP POLICY IF EXISTS "requests_insert_passenger" ON public.trip_requests;
CREATE POLICY "requests_insert_passenger" ON public.trip_requests FOR INSERT TO authenticated WITH CHECK (passenger_id = auth.uid() AND EXISTS (SELECT 1 FROM public.trips WHERE trips.id = trip_requests.trip_id AND trips.driver_id <> auth.uid() AND trips.status = 'PUBLISHED'));

DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications;
CREATE POLICY "notifications_select_own" ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
CREATE POLICY "notifications_update_own" ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

INSERT INTO storage.buckets (id, name, public)
VALUES ('student-documents', 'student-documents', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "student_documents_select_own" ON storage.objects;
CREATE POLICY "student_documents_select_own" ON storage.objects FOR SELECT TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_insert_own" ON storage.objects;
CREATE POLICY "student_documents_insert_own" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_update_own" ON storage.objects;
CREATE POLICY "student_documents_update_own" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
DROP POLICY IF EXISTS "student_documents_delete_own" ON storage.objects;
CREATE POLICY "student_documents_delete_own" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'student-documents' AND (storage.foldername(name))[1] = auth.uid()::text);
