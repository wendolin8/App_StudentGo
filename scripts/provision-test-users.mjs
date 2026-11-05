import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const configPath = '.env.pruebas.local';
const values = Object.fromEntries(readFileSync(configPath, 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
  }));

const ref = values.STUDENT_GO_TEST_PROJECT_REF;
const url = values.VITE_SUPABASE_URL;
const serviceKey = process.env.STUDENT_GO_TEST_ADMIN_KEY;
if (!ref || ref === 'woigbfrfkjwzcwljyxbi' || url !== `https://${ref}.supabase.co`) {
  throw new Error('Configuración rechazada: el destino debe ser únicamente student-go-pruebas.');
}
if (!serviceKey) throw new Error('Falta la credencial administrativa temporal del proyecto de pruebas.');

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const accounts = [
  { email: 'studentgo.admin@gmail.com', name: 'Student Go Admin Pruebas', studentNumber: '00000001', role: 'ADMIN', env: 'STUDENT_GO_ADMIN_PASSWORD' },
  { email: 'studentconductor@gmail.com', name: 'Conductor de Prueba', studentNumber: '00000002', role: 'STUDENT', env: 'STUDENT_GO_DRIVER_PASSWORD' },
  { email: 'studentpasajero@gmail.com', name: 'Pasajero de Prueba', studentNumber: '00000003', role: 'STUDENT', env: 'STUDENT_GO_PASSENGER_PASSWORD' },
];

function setLocalValue(key, value) {
  const content = readFileSync(configPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) lines[index] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(configPath, `${lines.filter((line, i) => i < lines.length - 1 || line).join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
}

async function listAllUsers() {
  const all = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new Error(`No se pudo consultar Authentication: ${error.message}`);
    all.push(...data.users);
    if (data.users.length < 100) return all;
  }
}

const users = await listAllUsers();
for (const account of accounts) {
  let user = users.find((candidate) => candidate.email?.toLowerCase() === account.email);
  let password = values[account.env];
  if (!user) {
    password = `${randomBytes(30).toString('base64url')}!aA7`;
    const { data, error } = await admin.auth.admin.createUser({
      email: account.email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: account.name,
        student_number: account.studentNumber,
        student_go_test_account: true,
      },
    });
    if (error || !data.user) throw new Error(`No se pudo crear ${account.email} en Authentication: ${error?.message ?? 'respuesta vacía'}`);
    user = data.user;
    setLocalValue(account.env, password);
  } else if (!password) {
    throw new Error(`${account.email} ya existe en pruebas; no se duplicó ni se cambió su contraseña. Restablécela desde Authentication > Users.`);
  }

  const { data: updated, error: profileError } = await admin.from('profiles')
    .update({ role: account.role, student_verified: false, driver_verified: false, whatsapp_alerts_consent_at: null })
    .eq('id', user.id).select('id, role, student_verified, driver_verified').maybeSingle();
  if (profileError || !updated) throw new Error(`No se pudo fijar el rol de prueba para ${account.email}: ${profileError?.message ?? 'perfil no encontrado'}`);
  console.log(`${account.email}: Authentication existe; rol ${updated.role}; verificación UTP=${updated.student_verified}; conductor=${updated.driver_verified}.`);
}

console.log('Contraseñas aleatorias guardadas únicamente en .env.pruebas.local, excluido de Git. No se envió correo ni WhatsApp.');
