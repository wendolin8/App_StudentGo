-- Deliver queued WhatsApp templates from the server every minute.
-- The URL and dispatch secret live in Vault and must be provisioned per Supabase project.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.dispatch_pending_whatsapp_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault, net
AS $$
DECLARE
  dispatch_url text;
  dispatch_secret text;
BEGIN
  SELECT decrypted_secret INTO dispatch_url
  FROM vault.decrypted_secrets WHERE name = 'student_go_whatsapp_dispatch_url'
  ORDER BY created_at DESC LIMIT 1;
  SELECT decrypted_secret INTO dispatch_secret
  FROM vault.decrypted_secrets WHERE name = 'student_go_whatsapp_dispatch_secret'
  ORDER BY created_at DESC LIMIT 1;
  IF dispatch_url IS NULL OR dispatch_secret IS NULL THEN
    RAISE NOTICE 'WhatsApp dispatcher is not configured in Vault.';
    RETURN;
  END IF;
  PERFORM net.http_post(
    dispatch_url,
    '{}'::jsonb,
    '{}'::jsonb,
    jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', dispatch_secret),
    10000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.dispatch_pending_whatsapp_messages() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE job_id bigint;
BEGIN
  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'student-go-whatsapp-dispatch';
  IF job_id IS NOT NULL THEN PERFORM cron.unschedule(job_id); END IF;
  PERFORM cron.schedule('student-go-whatsapp-dispatch', '* * * * *', 'SELECT public.dispatch_pending_whatsapp_messages()');
END;
$$;
