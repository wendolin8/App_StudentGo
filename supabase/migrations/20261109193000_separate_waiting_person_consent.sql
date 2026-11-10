-- The profile-level WhatsApp authorization permits StudentGo to use WhatsApp
-- for a recipient the student explicitly selects during a trip.  It must not
-- require consent for unrelated emergency contacts.  Each emergency contact
-- and each one-time companion keeps its own consent checks at send time.
CREATE OR REPLACE FUNCTION public.set_whatsapp_alert_consent(p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  IF p_enabled THEN
    UPDATE public.profiles
      SET whatsapp_alerts_consent_at = now()
      WHERE id = auth.uid();
  ELSE
    UPDATE public.profiles
      SET whatsapp_alerts_consent_at = NULL
      WHERE id = auth.uid();

    UPDATE public.ride_companions
      SET revoked_at = now()
      WHERE student_id = auth.uid()
        AND revoked_at IS NULL
        AND closed_at IS NULL;
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_whatsapp_alert_consent(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_whatsapp_alert_consent(boolean) TO authenticated;
