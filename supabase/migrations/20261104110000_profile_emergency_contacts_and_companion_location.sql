-- Keep emergency contact records bounded and allow consent-based live tracking
-- only while an active companion link exists for the authenticated passenger.

CREATE OR REPLACE FUNCTION public.enforce_two_emergency_contacts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  contact_count integer;
BEGIN
  -- Serialize inserts per student so two concurrent requests cannot exceed the cap.
  PERFORM 1 FROM public.profiles WHERE id = NEW.user_id FOR UPDATE;
  SELECT count(*) INTO contact_count
  FROM public.emergency_contacts
  WHERE user_id = NEW.user_id AND id IS DISTINCT FROM NEW.id;
  IF contact_count >= 2 THEN
    RAISE EXCEPTION 'MAX_EMERGENCY_CONTACTS' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS emergency_contacts_max_two ON public.emergency_contacts;
CREATE TRIGGER emergency_contacts_max_two
BEFORE INSERT OR UPDATE OF user_id ON public.emergency_contacts
FOR EACH ROW EXECUTE FUNCTION public.enforce_two_emergency_contacts();

CREATE OR REPLACE FUNCTION public.record_companion_location(
  p_trip_request_id uuid,
  p_latitude double precision,
  p_longitude double precision
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  trip_uuid uuid;
BEGIN
  IF auth.uid() IS NULL
    OR p_latitude IS NULL OR p_longitude IS NULL
    OR p_latitude NOT BETWEEN -90 AND 90
    OR p_longitude NOT BETWEEN -180 AND 180 THEN
    RETURN false;
  END IF;

  SELECT q.trip_id INTO trip_uuid
  FROM public.trip_requests q
  JOIN public.trips t ON t.id = q.trip_id
  WHERE q.id = p_trip_request_id
    AND q.passenger_id = auth.uid()
    AND q.status = 'ACCEPTED'
    AND q.trip_started_at IS NOT NULL
    AND q.trip_completed_at IS NULL
    AND t.status = 'IN_PROGRESS'
    AND EXISTS (
      SELECT 1 FROM public.ride_companions rc
      WHERE rc.trip_request_id = q.id
        AND rc.revoked_at IS NULL
        AND rc.closed_at IS NULL
        AND rc.expires_at > now()
    );

  IF trip_uuid IS NULL THEN RETURN false; END IF;

  INSERT INTO public.ride_trackings (trip_id, recorded_by, latitude, longitude, recorded_at)
  VALUES (trip_uuid, auth.uid(), p_latitude, p_longitude, now());
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_companion_location(uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_companion_location(uuid, double precision, double precision) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_two_emergency_contacts() FROM PUBLIC, anon, authenticated;
