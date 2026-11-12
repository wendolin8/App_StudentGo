import { corsHeaders, getAuthenticatedUser, jsonResponse, serviceClient } from '../_shared/whatsapp.ts';
import {
  applyFareAdjustment,
  calculateFormulaFare,
  parseGeminiAdjustment,
  type FareConfig,
} from '../_shared/fares.ts';
import { createSignedFareQuote } from '../_shared/fare-quotes.ts';

type Coordinates = { lat: number; lng: number };
type RouteInfo = { distanceKm: number; durationMin: number };
type FareRequest = {
  trip_id?: unknown;
  dropoff_text?: unknown;
  dropoff_lat?: unknown;
  dropoff_lng?: unknown;
};

type TripRow = {
  id: string;
  driver_id: string;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_lat: number | null;
  destination_lng: number | null;
  departure_at: string;
  available_seats: number;
  status: string;
};

const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';
const MAX_ROUTE_RATIO = 1.2;
const ROUTE_EXTRA_ALLOWANCE_KM = 2;

function isCoordinates(value: Coordinates): boolean {
  return Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

async function getDrivingRoute(origin: Coordinates, destination: Coordinates): Promise<RouteInfo | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=false`;
  const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
  if (!response.ok) return null;
  const body = await response.json() as {
    routes?: Array<{ distance?: number; duration?: number }>;
  };
  const route = body.routes?.[0];
  if (!route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration)) return null;
  return { distanceKm: route.distance! / 1000, durationMin: route.duration! / 60 };
}

function departureHourInPuebla(isoDate: string): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(isoDate));
}

async function requestGeminiAdjustment(input: {
  passengerKm: number;
  passengerMin: number;
  tripKm: number;
  tripMin: number;
  departureHour: string;
  occupiedSeats: number;
  availableSeats: number;
}): Promise<{ adjustmentPct: number; reason: string } | null> {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return null;

  const configuredModel = Deno.env.get('FARE_GEMINI_MODEL') ?? DEFAULT_GEMINI_MODEL;
  const model = /^[a-zA-Z0-9.-]+$/.test(configuredModel) ? configuredModel : DEFAULT_GEMINI_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(9000),
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: 'Eres un asistente de tarifas de carpool universitario en Puebla. Sugiere un ajuste pequeño y justo a la tarifa base. No vuelvas a calcular el precio. El ajuste debe estar entre -20 y 20 por ciento. Da una razón breve en español basada únicamente en los datos recibidos.' }],
      },
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify(input) }],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            adjustment_pct: { type: 'NUMBER' },
            reason: { type: 'STRING' },
          },
          required: ['adjustment_pct', 'reason'],
          propertyOrdering: ['adjustment_pct', 'reason'],
        },
      },
    }),
  });
  if (!response.ok) {
    console.error('calculate-fare: Gemini respondió HTTP', response.status);
    return null;
  }

  const body = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
  return text ? parseGeminiAdjustment(text) : null;
}

function numericConfig(row: Record<string, number | string>): FareConfig {
  return {
    baseFare: Number(row.base_fare),
    perKm: Number(row.per_km),
    perMinute: Number(row.per_minute),
    gasolinePerKm: Number(row.gasoline_per_km),
    minFare: Number(row.min_fare),
    maxFare: Number(row.max_fare),
  };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (request.method !== 'POST') return jsonResponse({ error: 'MÉTODO_NO_PERMITIDO' }, 405, origin);

  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: 'NO_AUTENTICADO' }, 401, origin);

  let input: FareRequest;
  try {
    input = await request.json() as FareRequest;
  } catch {
    return jsonResponse({ error: 'JSON_INVALIDO' }, 400, origin);
  }

  const dropoff = {
    lat: typeof input.dropoff_lat === 'number' ? input.dropoff_lat : Number.NaN,
    lng: typeof input.dropoff_lng === 'number' ? input.dropoff_lng : Number.NaN,
  };
  if (typeof input.trip_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.trip_id)
    || typeof input.dropoff_text !== 'string' || !input.dropoff_text.trim() || input.dropoff_text.length > 300
    || !isCoordinates(dropoff)) {
    return jsonResponse({ error: 'DATOS_DE_BAJADA_INVALIDOS' }, 400, origin);
  }

  const quoteSecret = Deno.env.get('FARE_QUOTE_SECRET');
  if (!quoteSecret || new TextEncoder().encode(quoteSecret).byteLength < 32) {
    return jsonResponse({ error: 'COTIZACION_NO_CONFIGURADA' }, 503, origin);
  }

  const db = serviceClient();
  const { data: trip, error: tripError } = await db.from('trips')
    .select('id, driver_id, origin_lat, origin_lng, destination_lat, destination_lng, departure_at, available_seats, status')
    .eq('id', input.trip_id).maybeSingle();
  if (tripError) return jsonResponse({ error: 'NO_SE_PUDO_CONSULTAR_EL_VIAJE' }, 500, origin);
  if (!trip) return jsonResponse({ error: 'VIAJE_NO_ENCONTRADO' }, 404, origin);

  const tripRow = trip as TripRow;
  if (tripRow.driver_id === user.id) return jsonResponse({ error: 'CONDUCTOR_NO_PUEDE_SOLICITAR' }, 403, origin);
  if (tripRow.status !== 'PUBLISHED' || tripRow.available_seats < 1) {
    return jsonResponse({ error: 'VIAJE_SIN_LUGARES' }, 409, origin);
  }

  if (tripRow.origin_lat === null || tripRow.origin_lng === null
    || tripRow.destination_lat === null || tripRow.destination_lng === null) {
    return jsonResponse({ error: 'VIAJE_SIN_COORDENADAS_VALIDAS' }, 422, origin);
  }
  const tripOrigin = { lat: tripRow.origin_lat, lng: tripRow.origin_lng };
  const tripDestination = { lat: tripRow.destination_lat, lng: tripRow.destination_lng };
  if (!isCoordinates(tripOrigin) || !isCoordinates(tripDestination)) {
    return jsonResponse({ error: 'VIAJE_SIN_COORDENADAS_VALIDAS' }, 422, origin);
  }

  const [{ data: configRow, error: configError }, { count: occupiedSeats, error: seatsError }] = await Promise.all([
    db.from('fare_config').select('base_fare, per_km, per_minute, gasoline_per_km, min_fare, max_fare').eq('id', 1).single(),
    db.from('trip_requests').select('id', { count: 'exact', head: true }).eq('trip_id', tripRow.id).eq('status', 'ACCEPTED'),
  ]);
  if (configError || !configRow) return jsonResponse({ error: 'CONFIGURACION_DE_TARIFA_NO_DISPONIBLE' }, 500, origin);
  if (seatsError) return jsonResponse({ error: 'NO_SE_PUDO_CONSULTAR_OCUPACION' }, 500, origin);

  let fullRoute: RouteInfo | null;
  let passengerRoute: RouteInfo | null;
  try {
    [fullRoute, passengerRoute] = await Promise.all([
      getDrivingRoute(tripOrigin, tripDestination),
      getDrivingRoute(tripOrigin, dropoff),
    ]);
  } catch {
    return jsonResponse({ error: 'SERVICIO_DE_RUTAS_NO_DISPONIBLE' }, 503, origin);
  }
  if (!fullRoute || !passengerRoute || fullRoute.distanceKm <= 0) {
    return jsonResponse({ error: 'NO_SE_ENCONTRO_RUTA_POR_CARRETERA' }, 422, origin);
  }
  const maxDropoffKm = fullRoute.distanceKm * MAX_ROUTE_RATIO + ROUTE_EXTRA_ALLOWANCE_KM;
  if (passengerRoute.distanceKm > maxDropoffKm) {
    return jsonResponse({ error: 'PUNTO_DE_BAJADA_FUERA_DEL_RECORRIDO' }, 422, origin);
  }

  const config = numericConfig(configRow as Record<string, number | string>);
  let formula;
  try {
    formula = calculateFormulaFare({
      passengerKm: passengerRoute.distanceKm,
      passengerMin: passengerRoute.durationMin,
      tripKm: fullRoute.distanceKm,
      config,
    });
  } catch {
    return jsonResponse({ error: 'CONFIGURACION_DE_TARIFA_INVALIDA' }, 500, origin);
  }

  const acceptedCount = occupiedSeats ?? 0;
  let source: 'ai' | 'formula' = 'formula';
  let adjustmentPct = 0;
  let explanation = 'Se aplicó la fórmula base porque el ajuste de IA no estuvo disponible.';
  try {
    const suggestion = await requestGeminiAdjustment({
      passengerKm: passengerRoute.distanceKm,
      passengerMin: passengerRoute.durationMin,
      tripKm: fullRoute.distanceKm,
      tripMin: fullRoute.durationMin,
      departureHour: departureHourInPuebla(tripRow.departure_at),
      occupiedSeats: acceptedCount,
      availableSeats: tripRow.available_seats,
    });
    if (suggestion) {
      source = 'ai';
      adjustmentPct = suggestion.adjustmentPct;
      explanation = suggestion.reason;
    }
  } catch {
    // La fórmula sigue disponible aunque falle Gemini.
  }

  const fare = source === 'ai'
    ? applyFareAdjustment(formula.total, adjustmentPct, config.minFare, config.maxFare)
    : formula.total;
  const breakdown = {
    formula_total: formula.total,
    adjustment_pct: adjustmentPct,
    ai_reason: explanation,
    components: formula,
    final_total: fare,
    passenger_distance_km: Number(passengerRoute.distanceKm.toFixed(2)),
    passenger_minutes: Math.round(passengerRoute.durationMin),
    trip_distance_km: Number(fullRoute.distanceKm.toFixed(2)),
    trip_minutes: Math.round(fullRoute.durationMin),
    occupied_seats: acceptedCount,
    available_seats: tripRow.available_seats,
  };

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const quoteToken = await createSignedFareQuote({
    user_id: user.id,
    trip_id: tripRow.id,
    dropoff_text: input.dropoff_text.trim(),
    dropoff_lat: dropoff.lat,
    dropoff_lng: dropoff.lng,
    passenger_distance_km: Number(passengerRoute.distanceKm.toFixed(2)),
    passenger_minutes: Math.round(passengerRoute.durationMin),
    fare,
    fare_source: source,
    fare_breakdown: breakdown,
    expires_at: expiresAt,
  }, quoteSecret);

  return jsonResponse({
    fare,
    breakdown,
    fare_source: source,
    explanation,
    quote_token: quoteToken,
    expires_at: expiresAt,
  }, 200, origin);
});
