import { jsonResponse, sendPendingFor, serviceClient } from '../_shared/whatsapp.ts';

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ ok: false, message: 'Método no permitido.' }, 405);
  const expected = Deno.env.get('WHATSAPP_DISPATCH_SECRET');
  const supplied = request.headers.get('x-dispatch-secret') ?? '';
  if (!expected || !constantTimeEqual(expected, supplied)) return jsonResponse({ ok: false, message: 'No autorizado.' }, 401);

  try {
    const db = serviceClient();
    const results = await sendPendingFor(db, {});
    return jsonResponse({ ok: true, checked: results.length, results });
  } catch (error) {
    console.error('whatsapp-dispatch failed', error instanceof Error ? error.message : 'unknown');
    return jsonResponse({ ok: false, message: 'No se pudo procesar la cola de WhatsApp.' }, 500);
  }
});

function constantTimeEqual(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length || !expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
  return difference === 0;
}
