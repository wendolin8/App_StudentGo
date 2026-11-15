import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { createPushHandler } from './handler.ts';
import { sendPush } from './send.ts';

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void };
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(createPushHandler({
  db,
  env: key => Deno.env.get(key),
  send: sendPush,
  background: task => EdgeRuntime.waitUntil(task),
  delay: () => new Promise(resolve => setTimeout(resolve, 15000)),
}));
