import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCache, readWithDeadline } from '../read-cache.js';

test('deduplicates concurrent reads and reuses values, including absent docs', async () => {
  const cache = new ReadCache();
  let reads = 0;
  const read = async () => { reads++; return null; };
  await Promise.all([cache.get('a', read), cache.get('a', read)]);
  await cache.get('a', read);
  assert.equal(reads, 1);
});
test('bounded storage, TTL and revision keys', async () => {
  let now = 0;
  const cache = new ReadCache({ ttl: 10, max: 2, now: () => now });
  cache.set('uid:image:rev1', 1);
  cache.set('uid:image:rev2', 2);
  assert.equal(cache.peek('uid:image:rev2'), 2);
  cache.set('other:image:rev1', 3);
  assert.equal(cache.peek('uid:image:rev1'), undefined);
  now = 11;
  assert.equal(cache.peek('uid:image:rev2'), undefined);
});
test('revocation/auth reset prevents late responses resurrecting a cache', async () => {
  for (const mode of ['drop', 'clear']) {
    const cache = new ReadCache();
    let finish;
    const pending = cache.get('uid:private:rev1', () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    if (mode === 'drop') cache.drop('uid:'); else cache.clear();
    finish('old data');
    await pending;
    assert.equal(cache.peek('uid:private:rev1'), undefined);
  }
});
test('failed reads can be retried and read deadlines settle', async () => {
  const cache = new ReadCache();
  await assert.rejects(cache.get('a', () => Promise.reject(new Error('offline'))));
  assert.equal(await cache.get('a', async () => 1), 1);
  await assert.rejects(readWithDeadline(new Promise(() => {}), 5), /通信/);
});
