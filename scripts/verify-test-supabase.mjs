import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(process.cwd(), '.env.pruebas.local');
const productionRef = 'woigbfrfkjwzcwljyxbi';

if (!existsSync(configPath)) {
  console.error('Falta .env.pruebas.local. Copia .env.pruebas.example y coloca los datos del proyecto de pruebas.');
  process.exit(1);
}

const values = Object.fromEntries(readFileSync(configPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    return [key, value];
  }));

const projectRef = values.STUDENT_GO_TEST_PROJECT_REF;
const projectUrl = values.VITE_SUPABASE_URL;
const publishableKey = values.VITE_SUPABASE_PUBLISHABLE_KEY || values.VITE_SUPABASE_ANON_KEY;

if (!projectRef || !/^[a-z0-9]{20}$/.test(projectRef)) {
  console.error('STUDENT_GO_TEST_PROJECT_REF debe ser el identificador válido del proyecto de pruebas.');
  process.exit(1);
}
if (projectRef === productionRef) {
  console.error('Bloqueado: la configuración apunta al proyecto de producción.');
  process.exit(1);
}

let parsedUrl;
try { parsedUrl = new URL(projectUrl); } catch { parsedUrl = null; }
if (!parsedUrl || parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== `${projectRef}.supabase.co`) {
  console.error('VITE_SUPABASE_URL no coincide con el identificador de pruebas.');
  process.exit(1);
}
if (!publishableKey || publishableKey.includes('YOUR_')) {
  console.error('Configura la clave publicable/anon del proyecto de pruebas; no se muestra su valor.');
  process.exit(1);
}

console.log(`Configuración validada para el proyecto aislado ${projectRef}.`);
