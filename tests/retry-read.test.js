import test from 'node:test';
import assert from 'node:assert/strict';
import { retryRead, ReadCache } from '../read-cache.js';

test('transient reads recover and concurrent callers share one retry sequence', async () => {
  let calls = 0;
  const cache = new ReadCache();
  const read = () => retryRead(() => {
    if (++calls < 3) throw { code: 'unavailable' };
    return 'image';
  }, { delay: async () => {} });
  assert.deepEqual(await Promise.all([cache.get('image', read), cache.get('image', read)]), ['image', 'image']);
  assert.equal(calls, 3);
});
test('permissions, missing images and invalid images are not retried', async () => {
  for (const code of ['permission-denied', 'not-found', 'invalid-argument']) {
    let calls = 0;
    await assert.rejects(retryRead(() => { calls++; throw { code }; }), e => e.code === code);
    assert.equal(calls, 1);
  }
});
test('retry attempts are bounded, timed out reads recover, stale sessions stop', async () => {
  let calls = 0;
  assert.equal(await retryRead(() => ++calls === 1 ? new Promise(() => {}) : 'ok',
    { timeout: 2, delay: async () => {} }), 'ok');
  calls = 0;
  await assert.rejects(retryRead(() => { calls++; throw { code: 'unavailable' }; },
    { delay: async () => {} }), e => e.code === 'unavailable');
  assert.equal(calls, 3);
  let current = true;
  calls = 0;
  await assert.rejects(retryRead(() => { calls++; throw { code: 'unavailable' }; },
    { current: () => current, delay: async () => { current = false; } }), e => e.code === 'cancelled');
  assert.equal(calls, 1);
});
