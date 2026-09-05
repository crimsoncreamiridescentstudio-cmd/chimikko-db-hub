import { mkdir, copyFile, readFile, writeFile, access, cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'index.html', 'terms.html', 'privacy.html', 'content-guidelines.html', 'legal.css',
  'app.css', 'app.js', 'image-codec.js', 'firebase-config.js', 'webp-client.js', 'read-cache.js',
  'manifest.webmanifest', 'pwa.js', 'sw.js', 'offline.html', 'og.png'
];
await mkdir(resolve(root, 'dist'), { recursive: true });
for (const file of files) await copyFile(resolve(root, file), resolve(root, 'dist', file));
await cp(resolve(root, 'icons'), resolve(root, 'dist/icons'), { recursive: true });
// Netlify supplies URL for the site's production origin, including custom domains.
// Local builds can use SITE_URL; localhost is deliberately not a deploy fallback.
const originInput = process.env.SITE_URL || process.env.URL;
if (process.env.NETLIFY && !originInput) throw new Error('Missing production URL for social metadata');
const origin = new URL(originInput || 'http://localhost:4173');
if (originInput && (origin.protocol !== 'https:' || origin.username || origin.password)) {
  throw new Error('SITE_URL/URL must be a public HTTPS origin');
}
const indexPath = resolve(root, 'dist/index.html');
await writeFile(indexPath, (await readFile(indexPath, 'utf8')).replaceAll('__SITE_ORIGIN__', origin.origin));
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
