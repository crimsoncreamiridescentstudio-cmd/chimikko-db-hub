import { mkdir, copyFile, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['index.html', 'app.css', 'app.js', 'image-codec.js', 'firebase-config.js'];
await mkdir(resolve(root, 'dist'), { recursive: true });
for (const file of files) await copyFile(resolve(root, file), resolve(root, 'dist', file));
const html = await readFile(resolve(root, 'dist', 'index.html'), 'utf8');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
  if (!/^(https?:|data:)/.test(reference)) await access(resolve(root, 'dist', reference));
}
console.log(`Static build complete: ${files.length} public files. Firebase configuration required before live use.`);
