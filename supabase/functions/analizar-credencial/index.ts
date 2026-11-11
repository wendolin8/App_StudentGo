import { createClient } from 'npm:@supabase/supabase-js@2';
import { jpeg, readForm } from './photos.ts';
import { readCredential } from './gemini.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (message: string, status = 200) => Response.json({ message }, { status, headers: cors });
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply('Método no permitido.', 405);
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false, autoRefreshToken: false } });
    const token = req.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return reply('Inicia sesión.', 401);
    const { data: { user }, error: authError } = await db.auth.getUser(token);
    if (authError || !user) return reply('Tu sesión ha expirado.', 401);
    const { data: profile, error: profileError } = await db.from('profiles')
      .select('full_name, student_number, student_verified, role').eq('id', user.id).single();
    if (profileError || !profile?.student_number || profile.role === 'ADMIN') return reply('Se requiere un perfil de estudiante.', 403);
    const table = db.from('student_credential_requests');
    const { data: open, error: lookupError } = await table.select('id').eq('user_id', user.id)
      .in('status', ['PENDING', 'APPROVED']).maybeSingle();
    if (lookupError) return reply('No se pudo consultar la solicitud.', 503);
    if (profile.student_verified || open) return reply('Ya existe una solicitud o verificación.');
    const form = await readForm(req);
    if (!form) return reply('El envío de fotos es demasiado grande o tiene un formato inválido.', 400);
    if (form.get('consent') !== 'yes') return reply('Acepta el análisis de la credencial.', 400);
    const front = await jpeg(form.get('front'));
    const back = await jpeg(form.get('back'));
    if (!front || !back) return reply('Se requieren dos fotos JPEG de hasta 1.5 MB.', 400);
    const id = crypto.randomUUID();
    const base = user.id + '/' + id + '/';
    const bucket = db.storage.from('student-credentials');
    const paths = [base + 'front.jpg', base + 'back.jpg'];
    const uploads = await Promise.all([front, back].map((bytes, i) =>
      bucket.upload(paths[i], bytes, { contentType: 'image/jpeg', upsert: false })));
    if (uploads.some(upload => upload.error)) {
      await bucket.remove(paths);
      return reply('Falló la carga de fotos. Puedes volver a intentar.', 503);
    }
    const { error } = await table.insert({ id, user_id: user.id,
      registered_name: profile.full_name, registered_number: profile.student_number });
    if (error) {
      // A connection failure can hide a successful commit. Never delete evidence in that case.
      if (/^[0-9A-Z]{5}$/.test(error.code)) await bucket.remove(paths);
      if (error.code === '23505') return reply('Ya existe una solicitud.');
      return reply('Consulta el estado en tu perfil antes de reintentar.', 503);
    }
    try {
      const reading = await readCredential(front, back);
      await table.update({ reading, analysis_status: 'READ' }).eq('id', id).eq('status', 'PENDING');
    } catch {
      await table.update({ analysis_status: 'UNAVAILABLE' }).eq('id', id).eq('status', 'PENDING');
    }
    return reply('Credencial enviada a revisión.');
  } catch {
    return reply('No se completó el envío. Consulta el estado en tu perfil.', 500);
  }
});
