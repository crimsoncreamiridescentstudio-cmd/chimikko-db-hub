let worker;
let sequence = 0;
const jobs = new Map();
function resetWorker(error) {
  worker?.terminate();
  worker = null;
  for (const job of jobs.values()) { clearTimeout(job.timer); job.reject(error); }
  jobs.clear();
}
export function encodeWebPInWorker(imageData, quality) {
  return new Promise((resolve, reject) => {
    try {
      if (!worker) {
        worker = new Worker(new URL('./webp-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }) => {
          const job = jobs.get(data.id);
          if (!job) return;
          clearTimeout(job.timer);
          jobs.delete(data.id);
          if (data.error) job.reject(new Error('WebP変換器を実行できませんでした。接続を確認して再度お試しください。'));
          else job.resolve(new Uint8Array(data.result));
        };
        worker.onerror = () => resetWorker(new Error('WebP変換器を読み込めませんでした。ページを再読み込みしてお試しください。'));
        worker.onmessageerror = () => resetWorker(new Error('画像データを変換器へ渡せませんでした。'));
      }
      const id = ++sequence;
      const timer = setTimeout(() => resetWorker(new Error('画像変換に時間がかかりすぎました。小さい画像で再度お試しください。')), 60000);
      jobs.set(id, { resolve, reject, timer });
      const pixels = imageData.data.slice().buffer;
      worker.postMessage({ id, pixels, width: imageData.width, height: imageData.height, quality }, [pixels]);
    } catch (error) { resetWorker(error); reject(error); }
  });
}
