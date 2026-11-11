import { supabase } from '@/lib/supabase';
import type { PlaceResult } from '@/lib/maps';

export type FareCalculation = {
  fare: number;
  fare_source: 'ai' | 'formula';
  explanation: string;
  quote_token: string | null;
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
): Promise<FareCalculation> {
  const { data, error } = await supabase.functions.invoke('calculate-fare', {
    body: {
      trip_id: tripId,
      dropoff_text: dropoff.label,
      dropoff_lat: dropoff.lat,
      dropoff_lng: dropoff.lng,
    },
  });
  if (error || data?.error) throw new Error('No se pudo calcular la tarifa con el servidor.');
  return data as FareCalculation;
}

export async function submitFareQuote(quoteToken: string): Promise<{ request_id: string }> {
  const { data, error } = await supabase.functions.invoke('request-trip', {
    body: { quote_token: quoteToken },
  });
  if (error || data?.error || typeof data?.request_id !== 'string') {
    throw new Error('No se pudo crear la solicitud con esta cotización.');
  }
  return data as { request_id: string };
}
