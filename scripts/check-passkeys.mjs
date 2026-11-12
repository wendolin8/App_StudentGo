import { loadEnv } from 'vite';

const env = loadEnv('pruebas', process.cwd(), '');
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const headers = { apikey: key, 'Content-Type': 'application/json' };
const appOrigin = new URL(process.argv[2] || 'http://localhost:5173');

async function request(path, method = 'GET') {
  const response = await fetch(`${env.VITE_SUPABASE_URL}/auth/v1/${path}`, {
    method, headers, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Supabase respondió ${response.status}: ${data.error_code ?? 'request_failed'}`);
  return data;
}

try {
  const settings = await request('settings');
  if (!settings.passkeys_enabled) {
    console.error('PENDIENTE: activa Passkeys en Supabase > Authentication > Passkeys. Consulta docs/PASSKEYS.md.');
    process.exitCode = 1;
  } else {
    // Requests a disposable challenge only; does not create users, credentials or sessions.
    const challenge = await request('passkeys/authentication/options', 'POST');
    const rpId = challenge.options?.rpId;
    const matches = typeof rpId === 'string' && (appOrigin.hostname === rpId || appOrigin.hostname.endsWith(`.${rpId}`));
    console.log(`Passkeys habilitadas. RP ID: ${rpId}. Dirección de prueba: ${appOrigin.origin}.`);
    const secure = appOrigin.protocol === 'https:' || (appOrigin.protocol === 'http:' && appOrigin.hostname === 'localhost');
    if (!matches || !secure) {
      console.error('La dirección no es compatible con el RP ID o no tiene HTTPS. Revisa Authentication > Passkeys.');
      process.exitCode = 1;
    } else {
      console.log('Dominio compatible. Confirma también que el origen exacto esté autorizado en el panel; la API pública no muestra esa lista.');
    }
  }
} catch (error) {
  console.error(`No se pudo comprobar Passkeys: ${error.message}`);
  process.exitCode = 1;
}
