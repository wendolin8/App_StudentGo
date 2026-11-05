-- Reject ride request + complete trip + safety confirmation functions

CREATE OR REPLACE FUNCTION public.reject_ride_request(request_id uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  req public.trip_requests%ROWTYPE;
  trip_row public.trips%ROWTYPE;
BEGIN
  SELECT * INTO req FROM public.trip_requests WHERE id = request_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'SOLICITUD_NO_EXISTE'; RETURN; END IF;
  SELECT * INTO trip_row FROM public.trips WHERE id = req.trip_id;
  IF trip_row.driver_id <> auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF req.status <> 'PENDING' THEN RETURN QUERY SELECT false, 'YA_PROCESADA'; RETURN; END IF;
  UPDATE public.trip_requests SET status = 'REJECTED' WHERE id = request_id;
  RETURN QUERY SELECT true, 'OK';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reject_ride_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_ride_request(uuid) TO authenticated;

-- Driver ends the trip (marks trip + all accepted requests as COMPLETED)
CREATE OR REPLACE FUNCTION public.complete_ride(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  trip_row public.trips%ROWTYPE;
BEGIN
  SELECT * INTO trip_row FROM public.trips WHERE id = trip_uuid;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'VIAJE_NO_EXISTE'; RETURN; END IF;
  IF trip_row.driver_id <> auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_CONDUCTOR'; RETURN; END IF;
  IF trip_row.status NOT IN ('IN_PROGRESS','PUBLISHED','FULL') THEN RETURN QUERY SELECT false, 'VIAJE_NO_ACTIVO'; RETURN; END IF;
  UPDATE public.trips SET status = 'COMPLETED', updated_at = now() WHERE id = trip_uuid;
  UPDATE public.trip_requests SET trip_completed_at = now(), status = 'COMPLETED'
    WHERE trip_id = trip_uuid AND status = 'ACCEPTED';
  RETURN QUERY SELECT true, 'OK';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.complete_ride(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_ride(uuid) TO authenticated;

-- Passenger confirms they arrived safely
CREATE OR REPLACE FUNCTION public.passenger_confirm_arrival(trip_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  req public.trip_requests%ROWTYPE;
BEGIN
  SELECT * INTO req FROM public.trip_requests
    WHERE trip_id = trip_uuid AND passenger_id = auth.uid() AND status = 'ACCEPTED';
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'SOLICITUD_NO_ENCONTRADA'; RETURN; END IF;
  IF req.passenger_confirmed_at IS NOT NULL THEN RETURN QUERY SELECT false, 'YA_CONFIRMADO'; RETURN; END IF;
  UPDATE public.trip_requests SET passenger_confirmed_at = now() WHERE id = req.id;
  RETURN QUERY SELECT true, 'OK';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.passenger_confirm_arrival(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.passenger_confirm_arrival(uuid) TO authenticated;

-- Resolve SOS alert
CREATE OR REPLACE FUNCTION public.resolve_sos(alert_uuid uuid)
RETURNS TABLE(ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  alert_row public.sos_alerts%ROWTYPE;
BEGIN
  SELECT * INTO alert_row FROM public.sos_alerts WHERE id = alert_uuid;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'ALERTA_NO_EXISTE'; RETURN; END IF;
  IF alert_row.user_id <> auth.uid() THEN RETURN QUERY SELECT false, 'NO_ES_DUENO'; RETURN; END IF;
  UPDATE public.sos_alerts SET resolved_at = now() WHERE id = alert_uuid;
  RETURN QUERY SELECT true, 'OK';
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.resolve_sos(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_sos(uuid) TO authenticated;
