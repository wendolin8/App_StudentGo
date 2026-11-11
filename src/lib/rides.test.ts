import { describe, expect, it, vi } from 'vitest';
import { canOfferPassengerCompanionship, type RideRequest } from './rides';

// These tests exercise ride rules without connecting to a real database.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

function request(overrides: Partial<RideRequest> = {}): RideRequest {
  return {
    id: 'request-1',
    tripId: 'trip-1',
    passengerId: 'passenger-1',
    status: 'ACCEPTED',
    fare: 25,
    requestedAt: '2026-11-05T12:00:00.000Z',
    passengerConfirmedAt: null,
    tripStartedAt: null,
    tripCompletedAt: null,
    qrUsedAt: null,
    ...overrides,
  };
}

describe('passenger companionship timing', () => {
  it('does not offer companionship merely because a seat was accepted', () => {
    expect(canOfferPassengerCompanionship(request())).toBe(false);
  });

  it('does not offer companionship for pending or rejected requests', () => {
    expect(canOfferPassengerCompanionship(request({ status: 'PENDING', qrUsedAt: '2026-11-05T12:05:00.000Z' }))).toBe(false);
    expect(canOfferPassengerCompanionship(request({ status: 'REJECTED', qrUsedAt: '2026-11-05T12:05:00.000Z' }))).toBe(false);
  });

  it('offers companionship only after this passenger QR was validated', () => {
    expect(canOfferPassengerCompanionship(request({ qrUsedAt: '2026-11-05T12:05:00.000Z' }))).toBe(true);
  });
});
