import { strict as assert } from 'node:assert';
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { createPushHandler } from './handler.ts';
import { sameSecret, validEndpoint, validSubscription } from './validation.ts';

const uid = '11111111-1111-4111-8111-111111111111';
const endpoint = 'https://fcm.googleapis.com/fcm/send/test-device';
const secret = 'a'.repeat(64);
const subscription = { endpoint, keys: {
  p256dh: btoa(String.fromCharCode(4, ...new Array(64).fill(1))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
  auth: btoa('1234567890123456').replace(/=/g, ''),
} };
function fixture(options: { validToken?: boolean; allowed?: boolean; sendStatus?: number; subscribed?: boolean } = {}) {
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] = [];
  const sends: object[] = []; const tasks: Promise<unknown>[] = [];
  const db = createClient('https://db.example.test', 'server-test-key', { auth: { persistSession: false }, global: {
    fetch: async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });
      const json = (value: unknown, status = 200) => Response.json(value, { status });
      if (url.pathname.endsWith('/auth/v1/user')) return options.validToken === false ? json({ message: 'invalid' }, 401) : json({ id: uid, aud: 'authenticated', email: 'test@example.test' });
      if (url.pathname.endsWith('/rpc/reserve_web_push_test')) return json(options.allowed !== false);
      if (url.pathname.endsWith('/rpc/register_web_push')) return json('22222222-2222-4222-8222-222222222222');
      if (url.pathname.endsWith('/notifications')) return json({ id: '33333333-3333-4333-8333-333333333333', user_id: uid });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (url.searchParams.get('select') === 'id') return json(options.subscribed === false ? null : { id: 'sub-1' });
      return json([{ id: 'sub-1', endpoint, ...subscription.keys }]);
    },
  } });
  const handler = createPushHandler({ db, env: name => ({ PUSH_WEBHOOK_SECRET: secret, PUSH_VAPID_PUBLIC_KEY: 'public', PUSH_VAPID_PRIVATE_KEY: 'private', PUSH_VAPID_SUBJECT: 'https://example.test' }[name]),
    send: async (sub, payload) => { sends.push({ sub, payload }); return options.sendStatus ?? 201; },
    background: promise => tasks.push(promise), delay: () => Promise.resolve(),
  });
  return { handler, calls, sends, tasks };
}
function req(body: object, headers: Record<string, string> = { Authorization: 'Bearer test-token' }) {
  return new Request('https://edge.example.test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
Deno.test('rejects private destinations, deceptive domains and invalid subscription keys', () => {
  for (const url of ['http://fcm.googleapis.com/fcm/send/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/fcm/send/x', 'https://fcm.googleapis.com@evil.test/x', 'https://fcm.googleapis.com:444/fcm/send/x']) assert.equal(validEndpoint(url), false);
  assert.equal(validSubscription(subscription), true);
  assert.equal(validSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } }), false);
  assert.equal(sameSecret(undefined, secret), false);
  assert.equal(sameSecret(secret, secret), true);
});
Deno.test('requires an authenticated user; body cannot impersonate a webhook', async () => {
  const f = fixture(); const res = await f.handler(req({ action: 'test', user_id: uid, type: 'INSERT' }, {}));
  assert.equal(res.status, 401); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
});
Deno.test('rejects invalid JWT and webhook secret before sending', async () => {
  const f = fixture({ validToken: false });
  assert.equal((await f.handler(req({ action: 'key' }))).status, 401);
  assert.equal((await f.handler(req({}, { 'x-push-hook-secret': 'wrong' }))).status, 401);
  assert.equal(f.sends.length, 0);
});
Deno.test('registration uses verified user ID, not a recipient supplied in JSON', async () => {
  const f = fixture(); assert.equal((await f.handler(req({ action: 'subscribe', subscription, user_id: 'attacker-chosen' }))).status, 200);
  assert.equal(f.calls.find(c => c.url.pathname.endsWith('/register_web_push'))?.body.p_user, uid);
});
Deno.test('test uses only the caller subscription and schedules real server delivery', async () => {
  const f = fixture(); const res = await f.handler(req({ action: 'test', endpoint, user_id: 'someone-else' }));
  assert.equal(res.status, 202); await Promise.all(f.tasks);
  assert.equal(f.sends.length, 1);
  for (const c of f.calls.filter(c => c.url.pathname.endsWith('/web_push_subscriptions'))) {
    assert.equal(c.url.searchParams.get('user_id'), 'eq.' + uid);
    assert.equal(c.url.searchParams.get('endpoint'), 'eq.' + endpoint);
  }
});
Deno.test('rate-limited tests and absent subscriptions never enqueue a delivery', async () => {
  for (const [settings, status] of [[{ allowed: false }, 429], [{ subscribed: false }, 409]] as const) {
    const f = fixture(settings); assert.equal((await f.handler(req({ action: 'test', endpoint }))).status, status);
    assert.equal(f.tasks.length, 0); assert.equal(f.sends.length, 0);
  }
});
Deno.test('unsubscribe restricts deletion to the signed-in account', async () => {
  const f = fixture(); assert.equal((await f.handler(req({ action: 'unsubscribe', endpoint }))).status, 200);
  const deletion = f.calls.find(c => c.method === 'DELETE');
  assert.equal(deletion?.url.searchParams.get('user_id'), 'eq.' + uid);
});
Deno.test('webhook looks up recipient from database and removes expired endpoints', async () => {
  const f = fixture({ sendStatus: 410 });
  const res = await f.handler(req({ type: 'INSERT', schema: 'public', table: 'notifications', record: { id: '33333333-3333-4333-8333-333333333333', user_id: 'forged' } }, { 'x-push-hook-secret': secret }));
  assert.equal(res.status, 200); assert.equal((await res.json()).expired, 1);
  assert.equal(f.calls.find(c => c.method === 'DELETE')?.url.searchParams.get('user_id'), 'eq.' + uid);
});
Deno.test('provider failure is not reported as a successful webhook', async () => {
  const f = fixture({ sendStatus: 503 });
  const res = await f.handler(req({ type: 'INSERT', schema: 'public', table: 'notifications', record: { id: '33333333-3333-4333-8333-333333333333' } }, { 'x-push-hook-secret': secret }));
  assert.equal(res.status, 502);
});
