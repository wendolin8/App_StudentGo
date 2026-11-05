-- Preserve the 10-minute arrival reminder deadline when completing a ride.
CREATE OR REPLACE FUNCTION public.complete_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  trip_row public.trips%ROWTYPE;
  deadline timestamptz := now() + interval '10 minutes';
BEGIN
  SELECT * INTO trip_row FROM public.trips t WHERE t.id = trip_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'VIAJE_NO_EXISTE'; RETURN; END IF;
  IF trip_row.driver_id IS DISTINCT FROM auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status <> 'IN_PROGRESS' THEN RETURN QUERY SELECT false, 'VIAJE_NO_ACTIVO'; RETURN; END IF;

  UPDATE public.trips SET status = 'COMPLETED', updated_at = now() WHERE id = trip_uuid;
  UPDATE public.trip_requests SET trip_completed_at = now(), arrival_deadline_at = deadline
    WHERE trip_id = trip_uuid AND status = 'ACCEPTED'
      AND trip_started_at IS NOT NULL AND trip_completed_at IS NULL;

  RETURN QUERY SELECT true, 'OK';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.complete_ride(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_ride(uuid) TO authenticated;
