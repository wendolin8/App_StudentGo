import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const config = Object.fromEntries(readFileSync('.env.pruebas.local', 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));

const projectRef = config.STUDENT_GO_TEST_PROJECT_REF;
if (!projectRef || projectRef === 'woigbfrfkjwzcwljyxbi' || config.VITE_SUPABASE_URL !== `https://${projectRef}.supabase.co`) {
  throw new Error('Configuración rechazada: se requiere el proyecto de pruebas, no producción.');
}

const participants = [
  { email: 'studentconductor@gmail.com', passwordKey: 'STUDENT_GO_DRIVER_PASSWORD', label: 'Conductor' },
  { email: 'studentpasajero@gmail.com', passwordKey: 'STUDENT_GO_PASSENGER_PASSWORD', label: 'Pasajero' },
];

for (const participant of participants) {
  const password = config[participant.passwordKey];
  if (!password) throw new Error(`Falta la contraseña local de ${participant.email}.`);
  const client = createClient(config.VITE_SUPABASE_URL, config.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: authError } = await client.auth.signInWithPassword({ email: participant.email, password });
  if (authError || !session.user) throw new Error(`Autenticación falló para ${participant.email}: ${authError?.message ?? 'sin sesión'}`);

  const { data: existing, error: listError } = await client.from('emergency_contacts')
    .select('id, name, relationship, phone, whatsapp_consent_at')
    .eq('user_id', session.user.id).order('created_at');
  if (listError) throw new Error(`No se pudieron consultar los contactos propios de ${participant.email}: ${listError.message}`);
  if (existing.length > 2) throw new Error(`${participant.email} ya tiene más de dos contactos de prueba; no se modificaron.`);

  const definitions = [
    { name: `Contacto ${participant.label} Prueba A`, relationship: 'Familiar de prueba', phone: '+12025550131' },
    { name: `Contacto ${participant.label} Prueba B`, relationship: 'Amistad de prueba', phone: '+12025550132' },
  ];
  const missing = definitions.filter((candidate) => !existing.some((row) => row.phone === candidate.phone));
  if (missing.length) {
    const { error } = await client.from('emergency_contacts').insert(missing.map((contact) => ({
      ...contact,
      user_id: session.user.id,
      notification_method: 'WHATSAPP',
      whatsapp_consent_at: null,
    })));
    if (error) throw new Error(`No se pudieron guardar los contactos ficticios de ${participant.email}: ${error.message}`);
  }
  const { data: saved, error: verifyError } = await client.from('emergency_contacts')
    .select('id, name, relationship, phone, whatsapp_consent_at')
    .eq('user_id', session.user.id).order('created_at');
  if (verifyError || saved.length !== 2) throw new Error(`La verificación RLS de contactos falló para ${participant.email}.`);
  if (saved.some((row) => row.whatsapp_consent_at !== null)) throw new Error('El fixture no debe declarar consentimiento real de WhatsApp.');
  console.log(`${participant.label}: 2 contactos ficticios visibles en la sesión propia; sin consentimiento WhatsApp y sin verificación telefónica.`);
  await client.auth.signOut();
}

console.log('No se enviaron mensajes externos. Números de fixture: 202-555-0131 y 202-555-0132 (rango reservado ficticio).');
