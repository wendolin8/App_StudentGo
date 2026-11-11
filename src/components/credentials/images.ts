export type Photos = { front: File | null; back: File | null; consent: boolean };
export const emptyPhotos: Photos = { front: null, back: null, consent: false };

export async function preparePhoto(file: File): Promise<Blob> {
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw Error('Elige fotos JPG o PNG de hasta 8 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('No se pudo leer la imagen.');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob || blob.size > 1536 * 1024) throw Error('Recorta la foto alrededor de la credencial y vuelve a intentar.');
    return blob;
  } finally {
    bitmap.close();
  }
}
