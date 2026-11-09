import { useCallback, useEffect, useRef, useState } from 'react';
import type L from 'leaflet';
import { MapPin, Search } from 'lucide-react';
import { addMarker, createMap, drawRoute, fitToRoute, getRoute, searchPlace, type LatLng, type PlaceResult, type RouteInfo } from '@/lib/maps';
import '@/styles/fares.css';

type Props = {
  origin: LatLng | null;
  destination: LatLng | null;
  onSelected: (place: PlaceResult, route: RouteInfo | null) => void;
};

export default function DropoffPicker({ origin, destination, onSelected }: Props) {
  const mapElement = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const routeRef = useRef<L.Polyline | null>(null);
  const onSelectedRef = useRef(onSelected);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [routeMessage, setRouteMessage] = useState('Busca un lugar o marca el punto directamente en el mapa.');

  useEffect(() => { onSelectedRef.current = onSelected; }, [onSelected]);

  const choosePlace = useCallback(async (place: PlaceResult) => {
    setQuery(place.label);
    setResults([]);
    markerRef.current?.remove();
    routeRef.current?.remove();
    if (mapRef.current) markerRef.current = addMarker(mapRef.current, place, 'Punto de bajada');
    if (!origin) {
      setRouteMessage('El viaje no tiene coordenadas de origen para calcular la ruta.');
      onSelectedRef.current(place, null);
      return;
    }

    setLoading(true);
    setRouteMessage('Calculando el tramo por carretera...');
    try {
      const route = await getRoute(origin, place);
      if (route) {
        if (mapRef.current) {
          routeRef.current = drawRoute(mapRef.current, route.geometry);
          fitToRoute(mapRef.current, route.geometry);
        }
        setRouteMessage(`${route.distanceKm.toFixed(1)} km · ${Math.round(route.durationMin)} min desde el origen.`);
      } else {
        setRouteMessage('No se pudo obtener la ruta ahora; mostraremos una estimación local.');
      }
      onSelectedRef.current(place, route);
    } catch {
      setRouteMessage('Sin conexión con el servicio de rutas; mostraremos una estimación local.');
      onSelectedRef.current(place, null);
    } finally {
      setLoading(false);
    }
  }, [origin]);

  useEffect(() => {
    if (!mapElement.current || !origin) return;
    const map = createMap(mapElement.current, origin, 13);
    mapRef.current = map;
    addMarker(map, origin, 'Origen del viaje');
    if (destination) addMarker(map, destination, 'Destino final');
    map.on('click', (event) => {
      const { lat, lng } = event.latlng;
      void choosePlace({ lat, lng, label: `Punto en el mapa (${lat.toFixed(5)}, ${lng.toFixed(5)})` });
    });
    if (destination) {
      void getRoute(origin, destination).then((route) => {
        if (route && mapRef.current === map) fitToRoute(map, route.geometry);
      }).catch(() => undefined);
    }
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      routeRef.current = null;
    };
  }, [origin, destination, choosePlace]);

  async function search(): Promise<void> {
    if (!query.trim()) return;
    setLoading(true);
    try {
      setResults(await searchPlace(query));
      setRouteMessage('Selecciona un resultado para mostrar el tramo.');
    } catch {
      setResults([]);
      setRouteMessage('No se pudo buscar el lugar; puedes marcarlo directamente en el mapa.');
    } finally {
      setLoading(false);
    }
  }

  return <section className="dropoff-picker">
    <label className="form-label">¿Dónde bajas?<span className="dropoff-search-row">
      <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="Busca un lugar o punto de referencia" />
      <button type="button" aria-label="Buscar punto de bajada" onClick={() => { void search(); }} disabled={loading}><Search size={16} /></button>
    </span></label>
    {results.length > 0 && <ul className="dropoff-results">{results.map((place, index) => <li key={`${place.lat}:${place.lng}:${index}`}>
      <button type="button" onClick={() => { void choosePlace(place); }}><MapPin size={14} /><span>{place.label}</span></button>
    </li>)}</ul>}
    <div ref={mapElement} className="leaflet-container-custom dropoff-map" aria-label="Mapa para elegir el punto de bajada" />
    <p className="dropoff-route-status" aria-live="polite">{loading ? 'Consultando...' : routeMessage}</p>
  </section>;
}
