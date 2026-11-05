import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export type WaMessage = {
  id: string;
  dedupe_key: string;
  owner_id: string;
  contact_id: string | null;
  companion_id: string | null;
  sos_alert_id: string | null;
  trip_request_id: string | null;
  purpose: 'TRIP_SHARE' | 'ARRIVAL_CONFIRMATION' | 'ARRIVAL_REMINDER' | 'SOS_ALERT';
  recipient_phone: string;
  template_name: string;
  template_parameters: string[];
  status: 'REQUESTED' | 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
  provider_message_id: string | null;
  claimed_at: string | null;
};

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('SUPABASE_BACKEND_CONFIGURATION_MISSING');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function whatsappConfiguration(): { ready: boolean; missing: string[] } {
  const required = [
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_GRAPH_API_VERSION',
    'WHATSAPP_LINK_ENCRYPTION_KEY', 'STUDENT_GO_APP_URL',
  ];
  return { ready: required.every((name) => !!Deno.env.get(name)), missing: required.filter((name) => !Deno.env.get(name)) };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeBase64(value: Uint8Array): string {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

async function encryptionKey(): Promise<CryptoKey> {
  const encoded = Deno.env.get('WHATSAPP_LINK_ENCRYPTION_KEY');
  if (!encoded) throw new Error('WHATSAPP_LINK_ENCRYPTION_KEY_MISSING');
  const raw = decodeBase64(encoded);
  if (raw.byteLength !== 32) throw new Error('WHATSAPP_LINK_ENCRYPTION_KEY_MUST_BE_32_BYTES_BASE64');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptTrackingToken(token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(), new TextEncoder().encode(token));
  return `v1.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(encrypted))}`;
}

export async function decryptTrackingToken(value: string): Promise<string> {
  const [version, encodedIv, encodedCipher] = value.split('.');
  if (version !== 'v1' || !encodedIv || !encodedCipher) throw new Error('INVALID_ENCRYPTED_TRACKING_TOKEN');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(encodedIv) },
    await encryptionKey(),
    decodeBase64(encodedCipher),
  );
  return new TextDecoder().decode(decrypted);
}

export function corsHeaders(origin: string | null): HeadersInit {
  const allowedOrigins = [Deno.env.get('STUDENT_GO_APP_URL') ?? '', ...(Deno.env.get('STUDENT_GO_ALLOWED_ORIGINS') ?? '').split(',')].map((value) => value.trim()).filter(Boolean);
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) allowedOrigins.push(origin);
  return {
    'Access-Control-Allow-Origin': origin && allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] ?? 'null'),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

export function jsonResponse(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' } });
}

export async function getAuthenticatedUser(request: Request): Promise<{ id: string; accessToken: string } | null> {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !anon) return null;
  const client = createClient(url, anon, { global: { headers: { Authorization: `Bearer ${match[1]}` } }, auth: { persistSession: false } });
  const { data, error } = await client.auth.getUser(match[1]);
  return error || !data.user ? null : { id: data.user.id, accessToken: match[1] };
}

async function templateParameters(db: SupabaseClient, message: WaMessage): Promise<string[]> {
  const values = Array.isArray(message.template_parameters) ? message.template_parameters : [];
  if (message.purpose === 'SOS_ALERT') return values.map(String);
  if (!message.companion_id) throw new Error('COMPANION_LINK_MISSING');
  const { data: companion, error } = await db.from('ride_companions')
    .select('token_ciphertext, name, student_id, revoked_at, closed_at, expires_at')
    .eq('id', message.companion_id).maybeSingle();
  if (error || !companion?.token_ciphertext || companion.revoked_at || companion.closed_at || new Date(companion.expires_at).getTime() <= Date.now()) {
    throw new Error('TRACKING_LINK_UNAVAILABLE');
  }
  const token = await decryptTrackingToken(companion.token_ciphertext);
  const baseUrl = Deno.env.get('STUDENT_GO_APP_URL')!.replace(/\/$/, '');
  return [...values.slice(0, 2).map(String), `${baseUrl}/seguimiento/${token}`];
}

export async function dispatchMessage(db: SupabaseClient, message: WaMessage): Promise<{ status: string; reason?: string }> {
  const { data: owner } = await db.from('profiles').select('whatsapp_alerts_consent_at').eq('id', message.owner_id).maybeSingle();
  let consentValid = !!owner?.whatsapp_alerts_consent_at;
  if (consentValid && message.contact_id) {
    const { data: contact } = await db.from('emergency_contacts').select('whatsapp_consent_at, notification_method').eq('id', message.contact_id).maybeSingle();
    consentValid = !!contact?.whatsapp_consent_at && contact.notification_method === 'WHATSAPP';
  }
  if (consentValid && message.companion_id) {
    const { data: companion } = await db.from('ride_companions').select('consent_at, whatsapp_consent_at, revoked_at, closed_at, expires_at').eq('id', message.companion_id).maybeSingle();
    consentValid = !!companion?.consent_at && !!companion.whatsapp_consent_at && !companion.revoked_at && !companion.closed_at && new Date(companion.expires_at).getTime() > Date.now();
  }
  if (!consentValid) {
    await db.from('whatsapp_messages').update({ status: 'CANCELLED', provider_status: 'cancelled_consent_revoked', failure_detail: 'No enviado: el consentimiento ya no está vigente.', cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', message.id).eq('status', 'REQUESTED');
    if (message.companion_id) await db.from('ride_companions').update({ delivery_status: 'CANCELLED' }).eq('id', message.companion_id);
    return { status: 'CANCELLED', reason: 'CONSENT_REVOKED' };
  }

  const config = whatsappConfiguration();
  if (!config.ready) {
    await db.from('whatsapp_messages').update({ failure_detail: `Configuración pendiente: ${config.missing.join(', ')}`, updated_at: new Date().toISOString() }).eq('id', message.id);
    return { status: 'REQUESTED', reason: 'WHATSAPP_CONFIGURATION_MISSING' };
  }

  const leaseCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { data: claimed, error: claimError } = await db.from('whatsapp_messages')
    .update({ claimed_at: new Date().toISOString(), failure_detail: null })
    .eq('id', message.id).eq('status', 'REQUESTED')
    .or(`claimed_at.is.null,claimed_at.lt.${leaseCutoff}`)
    .select('*').maybeSingle();
  if (claimError || !claimed) return { status: message.status };

  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN')!;
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID')!;
  const version = Deno.env.get('WHATSAPP_GRAPH_API_VERSION')!;
  try {
    const params = await templateParameters(db, claimed as WaMessage);
    const graphResponse = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: String(claimed.recipient_phone).replace('+', ''),
        type: 'template',
        template: {
          name: claimed.template_name,
          language: { code: 'es_MX' },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      }),
    });
    const responseBody = await graphResponse.json().catch(() => ({})) as { messages?: Array<{ id?: string; message_status?: string }>; error?: { message?: string; code?: number } };
    const providerId = responseBody.messages?.[0]?.id;
    if (!graphResponse.ok || !providerId) {
      const detail = responseBody.error?.message ?? `WhatsApp Graph API respondió HTTP ${graphResponse.status}`;
      await db.from('whatsapp_messages').update({ status: 'FAILED', provider_status: 'failed', failure_detail: detail.slice(0, 500), failed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', message.id);
      if (message.companion_id) await db.from('ride_companions').update({ delivery_status: 'FAILED' }).eq('id', message.companion_id);
      return { status: 'FAILED', reason: 'META_REJECTED_MESSAGE' };
    }
    await db.from('whatsapp_messages').update({ status: 'ACCEPTED', provider_status: responseBody.messages?.[0]?.message_status ?? 'accepted', provider_message_id: providerId, accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', message.id);
    if (message.companion_id) await db.from('ride_companions').update({ delivery_status: 'ACCEPTED', sent_at: new Date().toISOString() }).eq('id', message.companion_id);
    return { status: 'ACCEPTED' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Error desconocido de WhatsApp';
    await db.from('whatsapp_messages').update({ status: 'FAILED', provider_status: 'failed', failure_detail: detail.slice(0, 500), failed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', message.id);
    if (message.companion_id) await db.from('ride_companions').update({ delivery_status: 'FAILED' }).eq('id', message.companion_id);
    return { status: 'FAILED', reason: 'MESSAGE_DISPATCH_FAILED' };
  }
}

export async function sendPendingFor(db: SupabaseClient, filter: Record<string, string>): Promise<Array<{ id: string; status: string; reason?: string }>> {
  let query = db.from('whatsapp_messages').select('*').eq('status', 'REQUESTED').limit(10);
  for (const [key, value] of Object.entries(filter)) query = query.eq(key, value);
  const { data } = await query;
  const messages = (data ?? []) as WaMessage[];
  const results = [];
  for (const message of messages) results.push({ id: message.id, ...(await dispatchMessage(db, message)) });
  return results;
}
