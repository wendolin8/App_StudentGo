import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Leaflet usa OpenStreetMap (sin API key). OSRM da rutas reales con distancia y tiempo.
// Para usar Google Maps, sustituye los tiles y la API de rutas por una clave de Google.

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTR = '&copy; OpenStreetMap';
const ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving';
const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';

const defaultIcon = L.icon({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});
L.Marker.prototype.options.icon = defaultIcon;

export type LatLng = { lat: number; lng: number };
export type PlaceResult = { lat: number; lng: number; label: string };
export type RouteInfo = { distanceKm: number; durationMin: number; geometry: [number, number][] };

export function createMap(container: HTMLElement, center: LatLng, zoom = 14): L.Map {
  const map = L.map(container).setView([center.lat, center.lng], zoom);
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  return map;
}

export function addMarker(map: L.Map, pos: LatLng, label?: string): L.Marker {
  const marker = L.marker([pos.lat, pos.lng]).addTo(map);
  if (label) marker.bindPopup(label);
  return marker;
}

export function drawRoute(map: L.Map, geometry: [number, number][]): L.Polyline {
  return L.polyline(geometry.map(([lat, lng]) => [lat, lng] as [number, number]), {
    color: '#6366f1',
    weight: 5,
    opacity: 0.85,
  }).addTo(map);
}

export function fitToRoute(map: L.Map, points: [number, number][]): void {
  if (points.length) map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => [lat, lng] as [number, number])), { padding: [40, 40] });
}

export async function searchPlace(query: string): Promise<PlaceResult[]> {
  if (!query.trim()) return [];
  const url = `${GEOCODE_URL}?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=mx`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
  return data.map((item) => ({ lat: Number(item.lat), lng: Number(item.lon), label: item.display_name }));
}

export async function getRoute(origin: LatLng, destination: LatLng): Promise<RouteInfo | null> {
  const url = `${ROUTE_URL}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.routes?.length) return null;
  const route = data.routes[0];
  return {
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
    geometry: route.geometry.coordinates as [number, number][],
  };
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function getCurrentPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('La geolocalización no está disponible en este dispositivo.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.code === 1 ? 'Permiso de ubicación denegado. Activa el GPS en tu navegador.' : 'No pudimos obtener tu ubicación.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  });
}
