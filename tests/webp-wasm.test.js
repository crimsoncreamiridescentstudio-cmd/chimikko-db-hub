import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simd } from 'wasm-feature-detect';
import encode, { init as initEncode } from '@jsquash/webp/encode.js';
import decode, { init as initDecode } from '@jsquash/webp/decode.js';
import { prepareImage, isWebP } from '../image-codec.js';

test('real WASM fallback creates full+thumbnail within limits and preserves alpha', async () => {
  const encoder = await simd() ? 'webp_enc_simd.wasm' : 'webp_enc.wasm';
  await initEncode(await WebAssembly.compile(await readFile(new URL(`../node_modules/@jsquash/webp/codec/enc/${encoder}`, import.meta.url))));
  await initDecode(await WebAssembly.compile(await readFile(new URL('../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm', import.meta.url))));
  const original = { Image: globalThis.Image, ImageData: globalThis.ImageData, document: globalThis.document };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.Image = class { naturalWidth = 1600; naturalHeight = 1000; set src(value) { queueMicrotask(() => this.onload()); } };
  globalThis.document = { createElement() {
    return { width: 0, height: 0, toBlob(callback) { callback(new Blob(['png'], { type: 'image/png' })); },
      getContext() { return { clearRect() {}, drawImage() {}, getImageData(x, y, width, height) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i += 4) {
          data[i] = (i / 4) % 256; data[i + 1] = 120; data[i + 2] = 200; data[i + 3] = i === 0 ? 0 : i === 4 ? 128 : 255;
        }
        return { data, width, height };
      } }; }
    };
  } };
  try {
    const result = await prepareImage(new File(['test'], 'test.png', { type: 'image/png' }), {
      encodePixels: async (pixels, quality) => new Uint8Array(await encode(pixels, { quality: quality * 100, method: 3, alpha_quality: 100 }))
    });
    assert.equal(result.full.width, 1000);
    assert.ok(result.full.bytes.length <= 150000);
    assert.ok(result.thumb.bytes.length <= 20000);
    assert.ok(result.thumb.width <= 240);
    assert.equal(isWebP(result.full.bytes), true);
    const decoded = await decode(result.full.bytes.buffer);
    assert.equal(decoded.width, result.full.width);
    assert.equal(decoded.data[3], 0);
    assert.equal(decoded.data[7], 128);
    assert.equal(decoded.data[11], 255);
  } finally { Object.assign(globalThis, original); }
});
