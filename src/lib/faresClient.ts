import { supabase } from '@/lib/supabase';
import type { PlaceResult } from '@/lib/maps';

export type FareCalculation = {
  fare: number;
  source: 'ai' | 'formula';
  explanation: string;
  request_id: string | null;
  breakdown: {
    formula_total: number;
    adjustment_pct: number;
    components: { share: number; base: number; distance: number; time: number; gasoline: number; subtotal: number; total: number };
    final_total: number;
  };
};

export async function calculateTripFare(
  tripId: string,
  dropoff: PlaceResult,
  submit = false,
): Promise<FareCalculation> {
  const { data, error } = await supabase.functions.invoke('calculate-fare', {
    body: {
      trip_id: tripId,
      dropoff_text: dropoff.label,
      dropoff_lat: dropoff.lat,
      dropoff_lng: dropoff.lng,
      submit,
    },
  });
  if (error || data?.error) throw new Error('No se pudo calcular la tarifa con el servidor.');
  return data as FareCalculation;
}
