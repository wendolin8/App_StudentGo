import { corsHeaders, getAuthenticatedUser, jsonResponse, serviceClient } from '../_shared/whatsapp.ts';
import { verifySignedFareQuote } from '../_shared/fare-quotes.ts';

type RequestTripBody = { quote_token?: unknown };

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (request.method !== 'POST') return jsonResponse({ error: 'METODO_NO_PERMITIDO' }, 405, origin);

  const user = await getAuthenticatedUser(request);
  if (!user) return jsonResponse({ error: 'NO_AUTENTICADO' }, 401, origin);

  let body: RequestTripBody;
  try {
    body = await request.json() as RequestTripBody;
  } catch {
    return jsonResponse({ error: 'JSON_INVALIDO' }, 400, origin);
  }
  if (typeof body.quote_token !== 'string' || body.quote_token.length > 4096) {
    return jsonResponse({ error: 'COTIZACION_INVALIDA' }, 400, origin);
  }

  const secret = Deno.env.get('FARE_QUOTE_SECRET');
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    return jsonResponse({ error: 'COTIZACION_NO_CONFIGURADA' }, 503, origin);
  }

  const quote = await verifySignedFareQuote(body.quote_token, secret, user.id);
  if (!quote) return jsonResponse({ error: 'COTIZACION_INVALIDA_O_VENCIDA' }, 409, origin);

  const db = serviceClient();
  const { data: requestId, error } = await db.rpc('request_trip_with_dropoff', {
    p_trip_id: quote.trip_id,
    p_passenger_id: quote.user_id,
    p_dropoff_text: quote.dropoff_text,
    p_dropoff_lat: quote.dropoff_lat,
    p_dropoff_lng: quote.dropoff_lng,
    p_passenger_distance_km: quote.passenger_distance_km,
    p_passenger_minutes: quote.passenger_minutes,
    p_fare: quote.fare,
    p_fare_source: quote.fare_source,
    p_fare_breakdown: quote.fare_breakdown,
  });
  if (error) {
    const duplicate = error.message.includes('SOLICITUD_DUPLICADA');
    return jsonResponse({ error: duplicate ? 'SOLICITUD_DUPLICADA' : 'NO_SE_PUDO_CREAR_LA_SOLICITUD' }, duplicate ? 409 : 400, origin);
  }

  return jsonResponse({ request_id: requestId, fare: quote.fare, fare_source: quote.fare_source }, 201, origin);
});
