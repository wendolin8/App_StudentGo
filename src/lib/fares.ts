export type FareConfig = {
  baseFare: number;
  perKm: number;
  perMinute: number;
  gasolinePerKm: number;
  minFare: number;
  maxFare?: number;
};

export type FareInput = {
  passengerKm: number;   // km desde el origen hasta donde baja el pasajero
  passengerMin: number;  // minutos de ese tramo
  tripKm: number;        // km del viaje completo del conductor
  config: FareConfig;
};

export type FareBreakdown = {
  share: number;     // proporción del recorrido (0 a 1)
  base: number;
  distance: number;
  time: number;
  gasoline: number;
  subtotal: number;
  total: number;
};

const DEFAULT_MAX_FARE = 1000; // límite que ya tiene la base de datos

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
  if (config.minFare > maxFare) {
    throw new RangeError('minFare no puede superar maxFare.');
  }

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
