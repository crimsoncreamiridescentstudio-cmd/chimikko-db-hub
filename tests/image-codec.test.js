import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebP, prepareImage, IMAGE_KEYS } from '../image-codec.js';

const bytes = new Uint8Array(100);
bytes.set(new TextEncoder().encode('RIFF'), 0);
bytes.set(new TextEncoder().encode('WEBP'), 8);

test('WebP header check and four fixed image slots', () => {
  assert.equal(isWebP(bytes), true);
  assert.equal(isWebP(new Uint8Array(100)), false);
  assert.equal(isWebP(new Uint8Array(3)), false);
  assert.deepEqual(IMAGE_KEYS, ['avatar', 'char1', 'char2', 'char3']);
});

test('reject unsupported inputs before decoding', async () => {
  await assert.rejects(prepareImage({ type: 'image/svg+xml', size: 1 }), /PNG/);
  await assert.rejects(prepareImage({ type: 'image/png', size: 13 * 1024 * 1024 }), /12MB/);
});

test('encode tiny images, retain transparency path, bound output, and Safari fallback', async () => {
  const originalImage = globalThis.Image;
  const originalDocument = globalThis.document;
  let supported = true;
  globalThis.Image = class {
    naturalWidth = 40;
    naturalHeight = 60;
    set src(value) { queueMicrotask(() => this.onload()); }
  };
  globalThis.document = { createElement() {
    return { width: 0, height: 0,
      getContext() { return { clearRect() {}, drawImage() {} }; },
      toBlob(callback) { callback(new Blob([bytes], { type: supported ? 'image/webp' : 'image/png' })); }
    };
  } };
  try {
    const result = await prepareImage(new File([bytes], 'image.png', { type: 'image/png' }));
    assert.equal(result.full.width, 40);
    assert.equal(result.full.height, 60);
    assert.equal(result.thumb.bytes.length, 100);
    supported = false;
    const fallback = await prepareImage(new File([bytes], 'image.webp', { type: 'image/webp' }));
    assert.equal(fallback.thumb, null);
    assert.deepEqual(fallback.full.bytes, bytes);
    await assert.rejects(prepareImage(new File([bytes], 'image.png', { type: 'image/png' })), /未対応/);
  } finally {
    globalThis.Image = originalImage;
    globalThis.document = originalDocument;
  }
});
