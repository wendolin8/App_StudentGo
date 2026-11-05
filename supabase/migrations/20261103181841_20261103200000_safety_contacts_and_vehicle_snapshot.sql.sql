/*
# Datos visibles para acompañamiento

1. Cambios
- `emergency_contacts.notification_method` permite indicar el canal autorizado.
- `trips.vehicle_plates` conserva las placas del vehículo publicado para participantes del viaje.

2. Seguridad
- Los contactos siguen aislados por usuario.
- Las placas visibles en un viaje no exponen documentos privados.
- Se agrega un índice para evitar contactos duplicados por usuario y teléfono.
*/
ALTER TABLE public.emergency_contacts ADD COLUMN IF NOT EXISTS notification_method text NOT NULL DEFAULT 'PHONE' CHECK (notification_method IN ('PHONE','SMS','WHATSAPP','EMAIL'));
ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS vehicle_plates text;
CREATE UNIQUE INDEX IF NOT EXISTS emergency_contacts_phone_unique ON public.emergency_contacts (user_id, phone);
GRANT UPDATE (name, relationship, phone, notification_method) ON public.emergency_contacts TO authenticated;
CREATE OR REPLACE FUNCTION public.publish_trip_with_vehicle(p_vehicle_id uuid, p_origin_text text, p_destination_text text, p_origin_lat double precision, p_origin_lng double precision, p_destination_lat double precision, p_destination_lng double precision, p_departure_at timestamptz, p_available_seats integer, p_distance_km numeric, p_estimated_minutes integer, p_suggested_fare numeric, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE result_id uuid; vehicle_row public.vehicles%ROWTYPE;
BEGIN
  SELECT v.* INTO vehicle_row FROM public.vehicles v JOIN public.driver_applications a ON a.id = v.application_id WHERE v.id = p_vehicle_id AND v.owner_id = auth.uid() AND v.status = 'APPROVED' AND a.status = 'APPROVED' AND v.license_expires_at >= current_date AND v.registration_expires_at >= current_date;
  IF NOT FOUND THEN RAISE EXCEPTION 'VEHICULO_NO_APROBADO'; END IF;
  IF p_available_seats < 1 OR p_available_seats > vehicle_row.passenger_capacity OR p_departure_at <= now() THEN RAISE EXCEPTION 'DATOS_VIAJE_INVALIDOS'; END IF;
  INSERT INTO public.trips (driver_id, vehicle_id, vehicle_plates, origin_text, destination_text, origin_lat, origin_lng, destination_lat, destination_lng, departure_at, meeting_point, distance_km, estimated_minutes, available_seats, suggested_fare, vehicle_name, notes, status)
  VALUES (auth.uid(), p_vehicle_id, vehicle_row.plates, btrim(p_origin_text), btrim(p_destination_text), p_origin_lat, p_origin_lng, p_destination_lat, p_destination_lng, p_departure_at, btrim(p_origin_text), p_distance_km, p_estimated_minutes, p_available_seats, p_suggested_fare, vehicle_row.brand || ' ' || vehicle_row.model, p_notes, 'PUBLISHED') RETURNING id INTO result_id;
  RETURN result_id;
END; $$;
REVOKE EXECUTE ON FUNCTION public.publish_trip_with_vehicle(uuid,text,text,double precision,double precision,double precision,double precision,timestamptz,integer,numeric,integer,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_trip_with_vehicle(uuid,text,text,double precision,double precision,double precision,double precision,timestamptz,integer,numeric,integer,numeric,text) TO authenticated;
REVOKE UPDATE ON public.emergency_contacts FROM authenticated;
GRANT UPDATE (name, relationship, phone, notification_method) ON public.emergency_contacts TO authenticated;
