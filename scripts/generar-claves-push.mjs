import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
const text = [
  `PUSH_VAPID_PUBLIC_KEY=${publicKey}`,
  `PUSH_VAPID_PRIVATE_KEY=${jwk.d}`,
  'PUSH_VAPID_SUBJECT=https://app-student-go.vercel.app',
  `PUSH_WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`,
].join('\n') + '\n';
try {
  writeFileSync('.env.push.local', text, { flag: 'wx', mode: 0o600 });
  console.log('Claves guardadas en .env.push.local. No lo subas a Git ni compartas su contenido.');
} catch (error) {
  if (error.code === 'EEXIST') console.error('.env.push.local ya existe. Se conserva para no invalidar las suscripciones.');
  else throw error;
}
