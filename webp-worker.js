import encode, { init } from '@jsquash/webp/encode.js';

// Both scalar/SIMD binaries are served by this site, not an external service.
let ready;
let queue = Promise.resolve();
self.onmessage = ({ data: { id, pixels, width, height, quality } }) => {
  queue = queue.then(async () => {
    try {
      ready ||= init(null, { locateFile: path => new URL(`./vendor/${path}`, import.meta.url).href });
      await ready;
      const result = await encode({ data: new Uint8ClampedArray(pixels), width, height },
        { quality: quality * 100, method: 3, alpha_quality: 100 });
      self.postMessage({ id, result }, [result]);
    } catch (error) {
      ready = null;
      self.postMessage({ id, error: error?.message || 'WebP encoding failed' });
    }
  });
};
