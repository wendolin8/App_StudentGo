-- Run only after deploying whatsapp-dispatch and storing both values in Supabase Vault:
--   student_go_whatsapp_dispatch_url
--   student_go_whatsapp_dispatch_secret
-- Keep WhatsApp access tokens in Edge Function secrets, never in this SQL or pg_cron.

-- Enable pg_net first in Dashboard > Database > Extensions; Supabase manages its schema.

DO $$
DECLARE job_id bigint;
BEGIN
  FOR job_id IN SELECT jobid FROM cron.job WHERE jobname = 'student-go-whatsapp-dispatch' LOOP
    PERFORM cron.unschedule(job_id);
  END LOOP;
END;
$$;

SELECT cron.schedule(
  'student-go-whatsapp-dispatch',
  '* * * * *',
  $$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets
              WHERE name = 'student_go_whatsapp_dispatch_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-dispatch-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                              WHERE name = 'student_go_whatsapp_dispatch_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);
