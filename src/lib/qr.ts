import QRCode from 'qrcode';
import jsQR from 'jsqr';

export async function generateQr(token: string): Promise<string> {
  return QRCode.toDataURL(token, { margin: 1, width: 320, color: { dark: '#1f2547', light: '#ffffff' } });
}

export async function scanQrFromImage(file: File): Promise<string | null> {
  const img = await loadImage(file);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code?.data ?? null;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No pudimos leer la imagen del QR.'));
    img.src = URL.createObjectURL(file);
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
