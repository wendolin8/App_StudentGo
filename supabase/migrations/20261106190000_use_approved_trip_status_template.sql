-- student-go-pruebas: Meta approved studentgo_trip_status_v1 for the
-- post-trip companion update. The older arrival_confirmation_v1 was rejected.
-- This changes only the template selected for future queued messages.

CREATE OR REPLACE FUNCTION public.enqueue_arrival_confirmation_whatsapp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE c record; actor_name text;
BEGIN
  IF OLD.trip_completed_at IS NOT NULL OR NEW.trip_completed_at IS NULL THEN
    RETURN NEW;
  END IF;

  FOR c IN
    SELECT rc.id, rc.student_id, rc.name, rc.phone, ec.id AS contact_id
    FROM public.ride_companions rc
    JOIN public.profiles p ON p.id = rc.student_id
    LEFT JOIN public.emergency_contacts ec ON ec.user_id = rc.student_id AND ec.phone = rc.phone
    WHERE rc.trip_request_id = NEW.id AND rc.token_ciphertext IS NOT NULL
      AND rc.consent_at IS NOT NULL AND rc.whatsapp_consent_at IS NOT NULL
      AND rc.revoked_at IS NULL AND rc.closed_at IS NULL AND rc.expires_at > now()
      AND p.whatsapp_alerts_consent_at IS NOT NULL
  LOOP
    SELECT full_name INTO actor_name FROM public.profiles WHERE id = c.student_id;
    INSERT INTO public.whatsapp_messages
      (dedupe_key, owner_id, contact_id, companion_id, trip_request_id, purpose, recipient_phone, template_name, template_parameters)
    VALUES
      ('ARRIVAL_CONFIRMATION:' || c.id::text, c.student_id, c.contact_id, c.id, NEW.id,
       'ARRIVAL_CONFIRMATION', c.phone, 'studentgo_trip_status_v1',
       jsonb_build_array(c.name, coalesce(actor_name, 'Estudiante')))
    ON CONFLICT (dedupe_key) DO NOTHING;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_arrival_confirmation_whatsapp() FROM PUBLIC, anon, authenticated;
