import { serviceClient } from '../_shared/whatsapp.ts';

Deno.serve(async (request) => {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token && token === Deno.env.get('WHATSAPP_WEBHOOK_VERIFY_TOKEN') && challenge) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const appSecret = Deno.env.get('WHATSAPP_APP_SECRET');
  const signature = request.headers.get('X-Hub-Signature-256') ?? '';
  if (!appSecret || !signature.startsWith('sha256=')) return new Response('Unauthorized', { status: 401 });

  const rawBody = await request.arrayBuffer();
  if (!await validSignature(rawBody, appSecret, signature.slice('sha256='.length))) return new Response('Unauthorized', { status: 401 });

  try {
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as {
      entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id?: string; status?: string; errors?: Array<{ title?: string; message?: string; code?: number }> }> } }> }>;
    };
    const db = serviceClient();
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const update of change.value?.statuses ?? []) {
          if (!update.id || !update.status) continue;
          const providerStatus = update.status.toLowerCase();
          const status = providerStatus === 'delivered' || providerStatus === 'read' ? 'DELIVERED'
            : providerStatus === 'failed' ? 'FAILED' : providerStatus === 'sent' ? 'ACCEPTED' : null;
          if (!status) continue;
          const { data: message } = await db.from('whatsapp_messages')
            .select('id, status, companion_id, purpose').eq('provider_message_id', update.id).maybeSingle();
          if (!message) continue;
          const nextStatus = message.status === 'DELIVERED' && status === 'ACCEPTED' ? 'DELIVERED' : status;
          const failure = update.errors?.map((item) => item.title ?? item.message ?? String(item.code ?? 'Error del proveedor')).join('; ').slice(0, 500) ?? null;
          const now = new Date().toISOString();
          await db.from('whatsapp_messages').update({
            status: nextStatus,
            provider_status: providerStatus,
            ...(nextStatus === 'DELIVERED' ? { delivered_at: now, failure_detail: null } : {}),
            ...(nextStatus === 'FAILED' ? { failed_at: now, failure_detail: failure ?? 'WhatsApp reportó un fallo.' } : {}),
            updated_at: now,
          }).eq('id', message.id);
          if (message.companion_id) {
            const deliveryStatus = nextStatus === 'DELIVERED' ? 'DELIVERED' : nextStatus === 'FAILED' ? 'FAILED' : 'ACCEPTED';
            await db.from('ride_companions').update({ delivery_status: deliveryStatus }).eq('id', message.companion_id);
            if (message.purpose === 'ARRIVAL_REMINDER') {
              await db.from('ride_companions').update({ last_reminder_result: deliveryStatus }).eq('id', message.companion_id);
            }
          }
        }
      }
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
  } catch (error) {
    console.error('whatsapp-webhook failed', error instanceof Error ? error.message : 'unknown');
    return new Response('Invalid event', { status: 400 });
  }
});

async function validSignature(body: ArrayBuffer, secret: string, expectedHex: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const actualHex = [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actualHex.length !== expectedHex.length) return false;
  let difference = 0;
  for (let index = 0; index < actualHex.length; index += 1) difference |= actualHex.charCodeAt(index) ^ expectedHex.toLowerCase().charCodeAt(index);
  return difference === 0;
}
