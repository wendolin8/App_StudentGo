// Registration converts both photos to JPEG with a maximum edge of 1600 pixels.
export const maxSideBytes = 1536 * 1024;
const maxFormBytes = 2 * maxSideBytes + 16384;

export async function readForm(request: Request): Promise<FormData | null> {
  if (!request.body || Number(request.headers.get('Content-Length')) > maxFormBytes) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxFormBytes) { await reader.cancel(); return null; }
      parts.push(new Uint8Array(value));
    }
    const type = request.headers.get('Content-Type') || '';
    return await new Response(new Blob(parts), { headers: { 'Content-Type': type } }).formData();
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function jpeg(entry: FormDataEntryValue | null): Promise<Uint8Array | null> {
  if (!(entry instanceof File) || entry.type !== 'image/jpeg' || entry.size > maxSideBytes) return null;
  const bytes = new Uint8Array(await entry.arrayBuffer());
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return null;
  // Locate baseline or progressive frame header before decoding or sending the image.
  for (let i = 2; i + 8 < bytes.length && bytes[i] === 255;) {
    while (bytes[i] === 255) i++;
    const marker = bytes[i++];
    const length = bytes[i] * 256 + bytes[i + 1];
    if (length < 2 || i + length > bytes.length) return null;
    if (marker === 192 || marker === 194) {
      if (length < 11) return null;
      const height = bytes[i + 3] * 256 + bytes[i + 4];
      const width = bytes[i + 5] * 256 + bytes[i + 6];
      return height > 0 && width > 0 && Math.max(height, width) <= 1600 ? bytes : null;
    }
    if (marker === 218) return null;
    i += length;
  }
  return null;
}
