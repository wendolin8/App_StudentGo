import { describe, expect, it } from 'vitest';
import { applyFareAdjustment, calculateFormulaFare, parseGeminiAdjustment } from './fares';

const config = { baseFare: 10, perKm: 2.5, perMinute: 0.8, gasolinePerKm: 0.6, minFare: 15 };

describe('calculateFormulaFare', () => {
  it('calcula el viaje completo e incluye la parte de gasolina', () => {
    const result = calculateFormulaFare({ passengerKm: 10, passengerMin: 20, tripKm: 10, config });
    expect(result).toEqual({ share: 1, base: 10, distance: 25, time: 16, gasoline: 6, subtotal: 57, total: 57 });
  });

  it('calcula un precio proporcional para quien baja antes', () => {
    const result = calculateFormulaFare({ passengerKm: 4, passengerMin: 8, tripKm: 10, config });
    expect(result).toEqual({ share: 0.4, base: 4, distance: 10, time: 6.4, gasoline: 2.4, subtotal: 22.8, total: 22.8 });
  });

  it('respeta la tarifa mínima', () => {
    const result = calculateFormulaFare({ passengerKm: 1, passengerMin: 2, tripKm: 10, config });
    expect(result.total).toBe(15);
  });

  it('limita la tarifa máxima configurada', () => {
    const result = calculateFormulaFare({
      passengerKm: 100,
      passengerMin: 100,
      tripKm: 10,
      config: { ...config, maxFare: 100 },
    });
    expect(result.total).toBe(100);
  });

  it('redondea el resultado a centavos', () => {
    const result = calculateFormulaFare({
      passengerKm: 1,
      passengerMin: 1,
      tripKm: 3,
      config: { ...config, baseFare: 1, perKm: 0.1, perMinute: 0.1, gasolinePerKm: 0.1, minFare: 0 },
    });
    expect(result.total).toBe(0.63);
  });

  it('rechaza distancias o tarifas inválidas', () => {
    expect(() => calculateFormulaFare({ passengerKm: -1, passengerMin: 2, tripKm: 10, config })).toThrow(RangeError);
    expect(() => calculateFormulaFare({ passengerKm: 1, passengerMin: 2, tripKm: 0, config })).toThrow(RangeError);
    expect(() => calculateFormulaFare({
      passengerKm: 1,
      passengerMin: 2,
      tripKm: 10,
      config: { ...config, minFare: 150, maxFare: 100 },
    })).toThrow(RangeError);
  });

  it('valida la respuesta de Gemini y acota el ajuste a veinte por ciento', () => {
    expect(parseGeminiAdjustment('{"adjustment_pct": 45, "reason": "Mayor demanda"}')).toEqual({
      adjustmentPct: 20,
      reason: 'Mayor demanda',
    });
    expect(parseGeminiAdjustment('{"adjustment_pct": -45, "reason": "Menor demanda"}')?.adjustmentPct).toBe(-20);
    expect(parseGeminiAdjustment('{"adjustment_pct": "10", "reason": "No numérico"}')).toBeNull();
    expect(parseGeminiAdjustment('{"adjustment_pct": 5, "reason": "  "}')).toBeNull();
    expect(parseGeminiAdjustment('respuesta que no es JSON')).toBeNull();
  });

  it('aplica el ajuste sin rebasar los límites de tarifa', () => {
    expect(applyFareAdjustment(100, 20, 15, 1000)).toBe(120);
    expect(applyFareAdjustment(20, -20, 18, 1000)).toBe(18);
    expect(applyFareAdjustment(950, 20, 15, 1000)).toBe(1000);
  });
});
