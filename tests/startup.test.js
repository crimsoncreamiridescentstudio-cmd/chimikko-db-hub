import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('startup has no parser-blocking icon script and no remote Firebase imports', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(html, /<script[^>]+unpkg[^>]+async/);
  assert.match(html, /id="reload-app"/);
  assert.match(app, /import\('\.\/firebase-sdk.js'\)/);
  assert.doesNotMatch(app, /import\(["']https:/);
  assert.ok(app.indexOf('watchProfiles();') < app.indexOf('A.onAuthStateChanged'));
});
