import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { generateQr } from '@/lib/qr';

export default function QrPassengerCard({ tripId, started }: { tripId: string; started: boolean }) {
  const [qrUrl, setQrUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void supabase.rpc('get_my_ride_qr', { p_trip_id: tripId }).then(async ({ data, error: rpcError }) => {
      if (!active) return;
      if (rpcError || typeof data !== 'string') { setError('No pudimos cargar tu QR de abordaje.'); return; }
      const url = await generateQr(data);
      if (active) setQrUrl(url);
    });
    return () => { active = false; };
  }, [tripId]);

  return <div className="qr-card">
    <p className="eyebrow">TU QR DE ABORDAJE</p>
    {qrUrl && <img src={qrUrl} alt="QR del viaje" className="qr-image" />}
    {error && <div className="auth-error">{error}</div>}
    <span>{started ? 'Viaje en curso. Tu abordaje ya fue registrado.' : 'Muestra este QR al conductor cuando llegue por ti.'}</span>
  </div>;
}
