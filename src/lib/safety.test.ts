import { describe, expect, it } from 'vitest';
import { getSafetyLevel, type ActiveTrip, type SosIncident } from '@/lib/safety';

const activeTrip: ActiveTrip = {
  tripId: 'test-trip', role: 'STUDENT', route: 'Origen → destino', vehicle: 'Vehículo de prueba',
  arrivalAt: null, confirmed: false,
};

function incident(autoTriggered: boolean, latitude: number | null, longitude: number | null): SosIncident {
  return {
    id: 'test-sos', trip_id: 'test-trip', role: 'STUDENT', status: 'ACTIVE', latitude, longitude,
    message: null, auto_triggered: autoTriggered, created_at: new Date(0).toISOString(),
    verification_started_at: null, resolved_at: null, verified_by: null, resolution_method: null, resolution_note: null,
  };
}

describe('safety state presentation', () => {
  it('shows no active trip and a normal trip accurately', () => {
    expect(getSafetyLevel(null, [])).toEqual({ level: 'NONE', label: 'Sin viaje en curso' });
    expect(getSafetyLevel(activeTrip, [])).toEqual({ level: 'GREEN', label: 'Viaje en curso sin incidentes' });
  });

  it('shows pending arrival separately from an incident', () => {
    expect(getSafetyLevel({ ...activeTrip, arrivalAt: new Date().toISOString() }, [])).toEqual({ level: 'YELLOW', label: 'Esperando confirmación de llegada' });
  });

  it('raises the safety state for manual SOS and auto SOS without coordinates', () => {
    expect(getSafetyLevel(activeTrip, [incident(false, null, null)]).level).toBe('RED');
    expect(getSafetyLevel(activeTrip, [incident(true, null, null)])).toEqual({ level: 'RED', label: 'Escalado sin ubicación' });
  });
});
