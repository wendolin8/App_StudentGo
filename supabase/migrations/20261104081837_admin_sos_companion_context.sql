/*
# Admin incident context for companion-triggered SOS

1. New function
- `get_sos_incident_context(alert_uuid uuid)` returns the companion records linked to one SOS alert.
- Returns only display data: companion name, relationship, source, delivery status, arrival response, timestamps.
- Phone numbers and token hashes are never returned.

2. Security
- SECURITY DEFINER with a fixed search_path.
- Raises when the caller is not an administrator (checked with is_admin()).
- EXECUTE revoked from PUBLIC and anon; granted only to authenticated. The function itself enforces the admin check.

3. Notes
- Read-only. Resolving an alert continues to use the existing resolve_sos function.
*/

CREATE OR REPLACE FUNCTION public.get_sos_incident_context(alert_uuid uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'NO_AUTORIZADO' USING ERRCODE = '42501';
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'companion_id', rc.id,
      'name', rc.name,
      'relationship', rc.relationship,
      'source', rc.source,
      'delivery_status', rc.delivery_status,
      'arrival_response', rc.arrival_response,
      'arrival_responded_at', rc.arrival_responded_at,
      'expires_at', rc.expires_at,
      'revoked_at', rc.revoked_at,
      'created_at', rc.created_at
    ) ORDER BY rc.created_at)
    FROM public.ride_companions rc
    WHERE rc.sos_alert_id = alert_uuid
  ), '[]'::jsonb);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_sos_incident_context(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_sos_incident_context(uuid) TO authenticated;
