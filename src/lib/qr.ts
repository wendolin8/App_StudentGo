import QRCode from 'qrcode';
import jsQR from 'jsqr';

export async function generateQr(token: string): Promise<string> {
  return QRCode.toDataURL(token, { margin: 1, width: 320, color: { dark: '#1f2547', light: '#ffffff' } });
}

export async function scanQrFromImage(file: Blob, maxDimension?: number): Promise<string | null> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  const scale = maxDimension ? Math.min(1, maxDimension / Math.max(img.width, img.height)) : 1;
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code?.data ?? null;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No pudimos leer la imagen del QR.')); };
    img.src = url;
  });
}

export async function scanQrFromVideo(video: HTMLVideoElement): Promise<string | null> {
  if (video.videoWidth === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
  return code?.data ?? null;
}
