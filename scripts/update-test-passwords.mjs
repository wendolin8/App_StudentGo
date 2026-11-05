import { readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const configPath = '.env.pruebas.local';
const values = Object.fromEntries(readFileSync(configPath, 'utf8').split(/\r?\n/)
  .filter((line) => line.trim() && !line.trim().startsWith('#') && line.includes('='))
  .map((line) => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)]; }));

const ref = values.STUDENT_GO_TEST_PROJECT_REF;
const url = values.VITE_SUPABASE_URL;
const serviceKey = process.env.STUDENT_GO_TEST_ADMIN_KEY;
if (!ref || ref === 'woigbfrfkjwzcwljyxbi' || url !== `https://${ref}.supabase.co` || !serviceKey) {
  throw new Error('Bloqueado: solo se permiten contraseñas en student-go-pruebas con credencial administrativa temporal.');
}

const accounts = [
  ['studentgo.admin@gmail.com', 'StudentAdmin', 'STUDENT_GO_ADMIN_PASSWORD'],
  ['studentpasajero@gmail.com', 'StudentPasajero', 'STUDENT_GO_PASSENGER_PASSWORD'],
  ['studentconductor@gmail.com', 'StudentConductor', 'STUDENT_GO_DRIVER_PASSWORD'],
];
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 100 });
if (error) throw new Error(`No se pudieron consultar usuarios de prueba: ${error.message}`);

for (const [email, password, envName] of accounts) {
  const user = data.users.find((item) => item.email?.toLowerCase() === email);
  if (!user) throw new Error(`No existe la cuenta de pruebas ${email}.`);
  const { error: updateError } = await admin.auth.admin.updateUserById(user.id, { password });
  if (updateError) throw new Error(`No se pudo cambiar la contraseña de ${email}: ${updateError.message}`);
  values[envName] = password;
}

const current = readFileSync(configPath, 'utf8').split(/\r?\n/);
for (const [name, value] of Object.entries(values)) {
  const index = current.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) current[index] = `${name}=${value}`;
}
writeFileSync(configPath, `${current.filter((line) => line.length > 0).join('\n')}\n`, { mode: 0o600 });
console.log('Las tres contraseñas se actualizaron únicamente en student-go-pruebas y en el archivo local excluido de Git.');
