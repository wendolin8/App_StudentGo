-- Store each passenger's drop-off and server-calculated fare details.
ALTER TABLE public.trip_requests
  ADD COLUMN IF NOT EXISTS dropoff_text text,
  ADD COLUMN IF NOT EXISTS dropoff_lat double precision,
  ADD COLUMN IF NOT EXISTS dropoff_lng double precision,
  ADD COLUMN IF NOT EXISTS passenger_distance_km numeric(7, 2),
  ADD COLUMN IF NOT EXISTS passenger_minutes integer,
  ADD COLUMN IF NOT EXISTS fare_source text,
  ADD COLUMN IF NOT EXISTS fare_breakdown jsonb;

ALTER TABLE public.trip_requests
  DROP CONSTRAINT IF EXISTS trip_requests_fare_source_check,
  ADD CONSTRAINT trip_requests_fare_source_check
    CHECK (fare_source IS NULL OR fare_source IN ('ai', 'formula')),
  DROP CONSTRAINT IF EXISTS trip_requests_dropoff_coordinates_check,
  ADD CONSTRAINT trip_requests_dropoff_coordinates_check
    CHECK (
      (dropoff_lat IS NULL AND dropoff_lng IS NULL)
      OR (dropoff_lat BETWEEN -90 AND 90 AND dropoff_lng BETWEEN -180 AND 180)
    ),
  DROP CONSTRAINT IF EXISTS trip_requests_passenger_distance_check,
  ADD CONSTRAINT trip_requests_passenger_distance_check
    CHECK (passenger_distance_km IS NULL OR passenger_distance_km >= 0),
  DROP CONSTRAINT IF EXISTS trip_requests_passenger_minutes_check,
  ADD CONSTRAINT trip_requests_passenger_minutes_check
    CHECK (passenger_minutes IS NULL OR passenger_minutes >= 0);

-- Only the trusted Edge Function may call this RPC. It authenticates the user
-- before using its service-role client and passes that verified user ID here.
CREATE OR REPLACE FUNCTION public.request_trip_with_dropoff(
  p_trip_id uuid,
  p_passenger_id uuid,
  p_dropoff_text text,
  p_dropoff_lat double precision,
  p_dropoff_lng double precision,
  p_passenger_distance_km numeric,
  p_passenger_minutes integer,
  p_fare numeric,
  p_fare_source text,
  p_fare_breakdown jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
  request_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'BACKEND_ONLY';
  END IF;

  IF p_passenger_id IS NULL
    OR p_dropoff_text IS NULL OR btrim(p_dropoff_text) = ''
    OR length(btrim(p_dropoff_text)) > 300
    OR p_dropoff_lat IS NULL OR p_dropoff_lng IS NULL
    OR p_dropoff_lat NOT BETWEEN -90 AND 90
    OR p_dropoff_lng NOT BETWEEN -180 AND 180
    OR p_passenger_distance_km IS NULL OR p_passenger_distance_km < 0
    OR p_passenger_minutes IS NULL OR p_passenger_minutes < 0
    OR p_fare IS NULL OR p_fare < 0 OR p_fare > 1000
    OR p_fare_source IS NULL OR p_fare_source NOT IN ('ai', 'formula')
    OR p_fare_breakdown IS NULL OR jsonb_typeof(p_fare_breakdown) <> 'object'
  THEN
    RAISE EXCEPTION 'DATOS_TARIFA_INVALIDOS';
  END IF;

  SELECT * INTO trip_row
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'VIAJE_NO_ENCONTRADO';
  END IF;
  IF trip_row.status <> 'PUBLISHED' OR trip_row.available_seats < 1 THEN
    RAISE EXCEPTION 'VIAJE_SIN_LUGARES';
  END IF;
  IF trip_row.driver_id = p_passenger_id THEN
    RAISE EXCEPTION 'CONDUCTOR_NO_PUEDE_SOLICITAR';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.trip_requests
    WHERE trip_id = p_trip_id AND passenger_id = p_passenger_id
  ) THEN
    RAISE EXCEPTION 'SOLICITUD_DUPLICADA';
  END IF;

  INSERT INTO public.trip_requests (
    trip_id, passenger_id, fare, dropoff_text, dropoff_lat, dropoff_lng,
    passenger_distance_km, passenger_minutes, fare_source, fare_breakdown
  ) VALUES (
    p_trip_id, p_passenger_id, p_fare, btrim(p_dropoff_text), p_dropoff_lat,
    p_dropoff_lng, p_passenger_distance_km, p_passenger_minutes,
    p_fare_source, p_fare_breakdown
  ) RETURNING id INTO request_id;

  RETURN request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.request_trip_with_dropoff(
  uuid, uuid, text, double precision, double precision, numeric, integer,
  numeric, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_trip_with_dropoff(
  uuid, uuid, text, double precision, double precision, numeric, integer,
  numeric, text, jsonb
) TO service_role;

-- Remove the client's ability to choose fare or insert requests directly.
REVOKE INSERT ON public.trip_requests FROM anon, authenticated;
REVOKE INSERT (trip_id, passenger_id, fare) ON public.trip_requests FROM authenticated;
