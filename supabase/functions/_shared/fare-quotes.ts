export type FareQuotePayload = {
  user_id: string;
  trip_id: string;
  dropoff_text: string;
  dropoff_lat: number;
  dropoff_lng: number;
  passenger_distance_km: number;
  passenger_minutes: number;
  fare: number;
  fare_source: 'ai' | 'formula';
  fare_breakdown: Record<string, unknown>;
  expires_at: string;
};

const MAX_QUOTE_LIFETIME_MS = 10 * 60 * 1000;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidPayload(value: unknown): value is FareQuotePayload {
  if (!isRecord(value)) return false;
  const expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : Number.NaN;
  return typeof value.user_id === 'string' && value.user_id.length > 0
    && typeof value.trip_id === 'string' && value.trip_id.length > 0
    && typeof value.dropoff_text === 'string' && value.dropoff_text.trim().length > 0 && value.dropoff_text.length <= 300
    && typeof value.dropoff_lat === 'number' && Number.isFinite(value.dropoff_lat) && value.dropoff_lat >= -90 && value.dropoff_lat <= 90
    && typeof value.dropoff_lng === 'number' && Number.isFinite(value.dropoff_lng) && value.dropoff_lng >= -180 && value.dropoff_lng <= 180
    && typeof value.passenger_distance_km === 'number' && Number.isFinite(value.passenger_distance_km) && value.passenger_distance_km >= 0
    && typeof value.passenger_minutes === 'number' && Number.isInteger(value.passenger_minutes) && value.passenger_minutes >= 0
    && typeof value.fare === 'number' && Number.isFinite(value.fare) && value.fare >= 0 && value.fare <= 1000
    && (value.fare_source === 'ai' || value.fare_source === 'formula')
    && isRecord(value.fare_breakdown)
    && Number.isFinite(expiresAt);
}

async function importQuoteKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret);
  if (keyBytes.byteLength < 32) throw new Error('FARE_QUOTE_SECRET debe tener al menos 32 bytes.');
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function createSignedFareQuote(payload: FareQuotePayload, secret: string): Promise<string> {
  if (!hasValidPayload(payload)) throw new Error('Cotización de tarifa inválida.');
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importQuoteKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifySignedFareQuote(
  token: string,
  secret: string,
  expectedUserId: string,
  now = Date.now(),
): Promise<FareQuotePayload | null> {
  try {
    const [encodedPayload, encodedSignature, ...extra] = token.split('.');
    if (!encodedPayload || !encodedSignature || extra.length) return null;
    const payload: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(encodedPayload)));
    if (!hasValidPayload(payload) || payload.user_id !== expectedUserId) return null;

    const key = await importQuoteKey(secret, ['verify']);
    const isSignatureValid = await crypto.subtle.verify(
      'HMAC', key, decodeBase64Url(encodedSignature), new TextEncoder().encode(encodedPayload),
    );
    if (!isSignatureValid) return null;

    const expiry = Date.parse(payload.expires_at);
    if (expiry <= now || expiry > now + MAX_QUOTE_LIFETIME_MS) return null;
    return payload;
  } catch {
    return null;
  }
}
