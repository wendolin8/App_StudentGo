import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = 'dist';
const manifest = JSON.parse(await readFile(join(dist, '.vite', 'manifest.json'), 'utf8'));
const paths = new Set();
for (const entry of Object.values(manifest)) {
  for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) {
    paths.add(file);
  }
}
const assets = [...paths].sort();
const template = await readFile('public/sw.js', 'utf8');
const marker = "const BUILD = { version: 'local', assets: [] };";
if (!template.includes(marker) || !assets.length) {
  throw new Error('Revisa public/sw.js y el manifiesto de Vite antes de publicar.');
}
const hash = createHash('sha256').update(template);
for (const file of ['index.html', 'manifest.webmanifest', 'student-go-icon.svg', ...assets]) {
  hash.update(file).update(await readFile(join(dist, file)));
}
const build = { version: hash.digest('hex').slice(0, 20), assets: assets.map(file => '/' + file) };
await writeFile(join(dist, 'sw.js'), template.replace(marker, 'const BUILD = ' + JSON.stringify(build) + ';'));
console.log('StudentGo offline listo: ' + assets.length + ' recursos de Vite.');
