import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { scanQrFromImage, scanQrFromVideo } from '@/lib/qr';

export default function QrScannerModal({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState('');
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanFrameRef = useRef<number | null>(null);
  const validatingRef = useRef(false);

  async function startCamera() {
    setScanning(true);
    setResult('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        scanFrameRef.current = requestAnimationFrame(scanFrame);
      }
    } catch {
      setResult('No pudimos abrir la cámara para escanear.');
      setScanning(false);
    }
  }

  useEffect(() => () => {
    if (scanFrameRef.current !== null) cancelAnimationFrame(scanFrameRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  async function scanFrame(): Promise<void> {
    if (validatingRef.current) return;
    const video = videoRef.current;
    if (video) {
      const token = await scanQrFromVideo(video);
      if (token) {
        validatingRef.current = true;
        setResult('Validando código QR...');
        await validate(token);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        setScanning(false);
        return;
      }
    }
    scanFrameRef.current = requestAnimationFrame(() => { void scanFrame(); });
  }

  async function validate(token: string) {
    const { data, error } = await supabase.rpc('validate_ride_qr', { token_input: token });
    if (error || !data || !data[0]) { setResult('Error al validar el QR.'); return; }
    const r = data[0];
    if (r.valid) setResult('Pasajero verificado correctamente. Viaje iniciado.');
    else if (r.reason === 'NO_ES_CONDUCTOR') setResult('Solo el conductor de este viaje puede validar el QR.');
    else if (r.reason === 'TOKEN_NO_ENCONTRADO') setResult('El código QR no corresponde a este pasajero o viaje.');
    else if (r.reason === 'QR_YA_USADO') setResult('Este QR ya fue utilizado.');
    else if (r.reason === 'QR_EXPIRADO') setResult('El QR expiró. Pide al pasajero que actualice su viaje.');
    else setResult('No se pudo validar el QR.');
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await scanQrFromImage(file);
    if (text) await validate(text);
    else setResult('No se detectó un QR en la imagen.');
  }

  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card" onMouseDown={(e) => e.stopPropagation()}>
    <button className="modal-close" onClick={onClose}><X size={18} /></button>
    <p className="eyebrow center">ESCÁNER QR</p>
    <h2>Escanea el QR del pasajero</h2>
    {scanning && <video ref={videoRef} autoPlay playsInline muted className="qr-video" />}
    <button className="primary-button wide" onClick={() => { void startCamera(); }}><Camera size={17} /> Abrir cámara</button>
    <label className="secondary-button wide file-label"><Camera size={17} /> Subir imagen del QR<input type="file" accept="image/*" onChange={(e) => { void handleFile(e); }} hidden /></label>
    {result && <div className="auth-error">{result}</div>}
    <button className="secondary-button wide" onClick={onClose}>Cerrar</button>
  </div></div>;
}
