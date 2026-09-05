import { mkdir, copyFile, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'index.html', 'terms.html', 'privacy.html', 'content-guidelines.html', 'legal.css',
  'app.css', 'app.js', 'image-codec.js', 'firebase-config.js', 'webp-client.js', 'read-cache.js'
];
await mkdir(resolve(root, 'dist'), { recursive: true });
for (const file of files) await copyFile(resolve(root, file), resolve(root, 'dist', file));
await build({ entryPoints: [resolve(root, 'firebase-sdk.js')], outfile: resolve(root, 'dist/firebase-sdk.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'safari15', minify: true });
await build({ entryPoints: [resolve(root, 'webp-worker.js')], outfile: resolve(root, 'dist/webp-worker.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'safari15', minify: true });
await mkdir(resolve(root, 'dist/vendor'), { recursive: true });
for (const name of ['webp_enc.wasm', 'webp_enc_simd.wasm']) {
  await copyFile(resolve(root, 'node_modules/@jsquash/webp/codec/enc', name), resolve(root, 'dist/vendor', name));
}
await copyFile(resolve(root, 'node_modules/@jsquash/webp/LICENSE'), resolve(root, 'dist/vendor/WEBP-LICENSE.txt'));
await copyFile(resolve(root, 'node_modules/@jsquash/webp/codec/LICENSE.codec.md'), resolve(root, 'dist/vendor/WEBP-CODEC-LICENSE.md'));
const html = await readFile(resolve(root, 'dist', 'index.html'), 'utf8');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
  if (!/^(https?:|data:)/.test(reference)) await access(resolve(root, 'dist', reference));
}
console.log(`Static build complete: ${files.length} public files plus WebP worker, WASM and licenses.`);
