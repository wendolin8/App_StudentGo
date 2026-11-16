import { describe, expect, it } from 'vitest';
import { createSignedFareQuote, verifySignedFareQuote, type FareQuotePayload } from './fareQuotes';

const secret = 'student-go-test-quote-secret-with-32-bytes';
const now = Date.parse('2026-11-11T18:00:00.000Z');

function quote(overrides: Partial<FareQuotePayload> = {}): FareQuotePayload {
  return {
    user_id: 'passenger-123',
    trip_id: 'trip-456',
    dropoff_text: 'Parque Puebla',
    dropoff_lat: 19.073,
    dropoff_lng: -98.2027,
    passenger_distance_km: 4.25,
    passenger_minutes: 12,
    fare: 28.5,
    fare_source: 'ai',
    fare_breakdown: { formula_total: 25, adjustment_pct: 14, final_total: 28.5 },
    expires_at: new Date(now + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

describe('cotizaciones firmadas de tarifa', () => {
  it('acepta una firma válida para el usuario y viaje cotizados', async () => {
    const payload = quote();
    const token = await createSignedFareQuote(payload, secret);
    await expect(verifySignedFareQuote(token, secret, payload.user_id, now + 1000)).resolves.toEqual(payload);
  });

  it('rechaza una firma alterada', async () => {
    const token = await createSignedFareQuote(quote(), secret);
    const [body, signature] = token.split('.');
    const changedSignature = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    await expect(verifySignedFareQuote(`${body}.${changedSignature}`, secret, 'passenger-123', now)).resolves.toBeNull();
  });

  it('rechaza una cotización vencida', async () => {
    const expired = quote({ expires_at: new Date(now - 1).toISOString() });
    const token = await createSignedFareQuote(expired, secret);
    await expect(verifySignedFareQuote(token, secret, expired.user_id, now)).resolves.toBeNull();
  });

  it('rechaza una cotización perteneciente a otro usuario', async () => {
    const payload = quote();
    const token = await createSignedFareQuote(payload, secret);
    await expect(verifySignedFareQuote(token, secret, 'different-user', now)).resolves.toBeNull();
  });
});
