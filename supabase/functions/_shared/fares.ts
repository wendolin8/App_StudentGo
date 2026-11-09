export type FareConfig = {
  baseFare: number;
  perKm: number;
  perMinute: number;
  gasolinePerKm: number;
  minFare: number;
  maxFare?: number;
};

export type FareInput = {
  passengerKm: number;
  passengerMin: number;
  tripKm: number;
  config: FareConfig;
};

export type FareBreakdown = {
  share: number;
  base: number;
  distance: number;
  time: number;
  gasoline: number;
  subtotal: number;
  total: number;
};

export type AiFareAdjustment = { adjustmentPct: number; reason: string };

const DEFAULT_MAX_FARE = 1000;
const MAX_AI_ADJUSTMENT_PCT = 20;

function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${field} debe ser un número finito igual o mayor que cero.`);
  }
}

export function calculateFormulaFare({ passengerKm, passengerMin, tripKm, config }: FareInput): FareBreakdown {
  assertNonNegativeFinite(passengerKm, 'passengerKm');
  assertNonNegativeFinite(passengerMin, 'passengerMin');
  if (!Number.isFinite(tripKm) || tripKm <= 0) {
    throw new RangeError('tripKm debe ser un número finito mayor que cero.');
  }

  assertNonNegativeFinite(config.baseFare, 'baseFare');
  assertNonNegativeFinite(config.perKm, 'perKm');
  assertNonNegativeFinite(config.perMinute, 'perMinute');
  assertNonNegativeFinite(config.gasolinePerKm, 'gasolinePerKm');
  assertNonNegativeFinite(config.minFare, 'minFare');
  const maxFare = config.maxFare ?? DEFAULT_MAX_FARE;
  assertNonNegativeFinite(maxFare, 'maxFare');
  if (config.minFare > maxFare) throw new RangeError('minFare no puede superar maxFare.');

  const share = Math.min(passengerKm / tripKm, 1);
  const base = config.baseFare * share;
  const distance = passengerKm * config.perKm;
  const time = passengerMin * config.perMinute;
  const gasoline = passengerKm * config.gasolinePerKm;
  const subtotal = base + distance + time + gasoline;
  const total = Math.min(maxFare, Math.max(config.minFare, roundCurrency(subtotal)));

  return {
    share,
    base: roundCurrency(base),
    distance: roundCurrency(distance),
    time: roundCurrency(time),
    gasoline: roundCurrency(gasoline),
    subtotal: roundCurrency(subtotal),
    total: roundCurrency(total),
  };
}

export function parseGeminiAdjustment(text: string): AiFareAdjustment | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const value = parsed as Record<string, unknown>;
    if (typeof value.adjustment_pct !== 'number' || !Number.isFinite(value.adjustment_pct)) return null;
    if (typeof value.reason !== 'string') return null;

    const reason = value.reason.trim();
    if (!reason || reason.length > 240) return null;
    const adjustmentPct = Math.max(-MAX_AI_ADJUSTMENT_PCT, Math.min(MAX_AI_ADJUSTMENT_PCT, value.adjustment_pct));
    return { adjustmentPct, reason };
  } catch {
    return null;
  }
}

export function applyFareAdjustment(
  formulaFare: number,
  adjustmentPct: number,
  minFare: number,
  maxFare = DEFAULT_MAX_FARE,
): number {
  assertNonNegativeFinite(formulaFare, 'formulaFare');
  assertNonNegativeFinite(minFare, 'minFare');
  assertNonNegativeFinite(maxFare, 'maxFare');
  if (!Number.isFinite(adjustmentPct)) throw new RangeError('adjustmentPct debe ser finito.');
  if (minFare > maxFare) throw new RangeError('minFare no puede superar maxFare.');
  const boundedPct = Math.max(-MAX_AI_ADJUSTMENT_PCT, Math.min(MAX_AI_ADJUSTMENT_PCT, adjustmentPct));
  return roundCurrency(Math.min(maxFare, Math.max(minFare, formulaFare * (1 + boundedPct / 100))));
}
