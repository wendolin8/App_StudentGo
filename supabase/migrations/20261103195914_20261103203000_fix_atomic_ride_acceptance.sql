/*
# Fix atomic passenger acceptance

1. Root cause
- The existing acceptance RPC called `gen_random_bytes`, which is unavailable in the provisioned database. The request therefore stayed PENDING and no QR was issued.

2. Function behavior
- Replace QR token generation with the existing `gen_random_uuid()` capability.
- Lock the selected trip and request while validating and updating them.
- Allow only the authenticated owner of the trip to accept it.
- Accept only PENDING requests on active trips with available seats.
- Decrease available seats atomically and mark the trip FULL when the last seat is accepted.
- Keep repeated acceptance, non-owner access, unavailable trips, and full trips rejected with specific reasons.
- Create a private notification for the passenger after acceptance.

3. Security
- RLS remains enabled and unchanged.
- The function remains SECURITY DEFINER with a fixed search path.
- Anonymous EXECUTE remains revoked; authenticated users may call the function, but ownership is checked inside the function.
- No account, request, trip, or passenger data is deleted.
*/

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
  SELECT * INTO req
  FROM public.trip_requests
  WHERE id = request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'SOLICITUD_NO_EXISTE';
    RETURN;
  END IF;

  SELECT * INTO trip_row
  FROM public.trips
  WHERE id = req.trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::text, 'VIAJE_NO_EXISTE';
    RETURN;
  END IF;

  IF trip_row.driver_id <> auth.uid() THEN
    RETURN QUERY SELECT false, NULL::text, 'NO_ES_CONDUCTOR_PROPIETARIO';
    RETURN;
  END IF;

  IF req.status <> 'PENDING' THEN
    RETURN QUERY SELECT false, NULL::text, 'SOLICITUD_YA_PROCESADA';
    RETURN;
  END IF;

  IF trip_row.status NOT IN ('PUBLISHED', 'FULL') THEN
    RETURN QUERY SELECT false, NULL::text, 'VIAJE_NO_ACTIVO';
    RETURN;
  END IF;

  IF trip_row.available_seats < 1 THEN
    RETURN QUERY SELECT false, NULL::text, 'SIN_LUGARES_DISPONIBLES';
    RETURN;
  END IF;

  new_token := gen_random_uuid()::text || '-' || request_id::text;

  UPDATE public.trip_requests
  SET status = 'ACCEPTED',
      accepted_at = now(),
      qr_token = new_token,
      qr_issued_at = now()
  WHERE id = request_id;

  UPDATE public.trips
  SET available_seats = available_seats - 1,
      status = CASE WHEN available_seats - 1 = 0 THEN 'FULL' ELSE status END,
      updated_at = now()
  WHERE id = trip_row.id;

  INSERT INTO public.notifications (user_id, title, message, type, target, reference_id)
  VALUES (
    req.passenger_id,
    'Solicitud aceptada',
    'Tu solicitud de pasajero fue aceptada. Ya puedes mostrar tu QR de abordaje.',
    'RIDE_ACCEPTED',
    'TRIPS',
    req.trip_id
  );

  RETURN QUERY SELECT true, new_token, 'OK';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.accept_ride_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_ride_request(uuid) TO authenticated;