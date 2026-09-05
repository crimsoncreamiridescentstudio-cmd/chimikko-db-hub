export const IMAGE_KEYS = ["avatar", "char1", "char2", "char3"];
export const MAX_IMAGE_BYTES = 150000;
export const MAX_THUMB_BYTES = 20000;
const INPUT_LIMIT = 12 * 1024 * 1024;

export function isWebP(bytes) {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("画像を読み込めません。PNG・JPEG・WebPで試してください。"));
    img.src = url;
  });
}

async function encode(img, edge, budget) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("このブラウザでは画像を変換できません。");
  for (let size = Math.min(edge, Math.max(img.naturalWidth, img.naturalHeight)); size >= 1; size = Math.floor(size * .8)) {
    const ratio = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of [.86, .72, .58, .44]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob || blob.type !== "image/webp") {
        throw new Error("このブラウザはWebP変換に未対応です。別のブラウザで試すか、150KB以下・長辺1000px以下のWebPを選んでください。");
      }
      if (blob.size <= budget) return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
    }
    if (size <= 80) break;
  }
  throw new Error("容量内に圧縮できませんでした。小さい画像で試してください。");
}

export async function prepareImage(file) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("PNG・JPEG・WebPを選んでください。アニメーションは静止画になります。");
  if (file.size > INPUT_LIMIT) throw new Error("元画像は12MB以下にしてください。");
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 24000000) throw new Error("画像が大きすぎます。2400万画素以下に縮小してください。");
    // Safari等のWebPエンコード未対応環境でも、既に小さいWebPなら保存可能。
    const original = file.type === "image/webp" ? new Uint8Array(await file.arrayBuffer()) : null;
    const reusable = original && isWebP(original) && file.size <= MAX_IMAGE_BYTES && Math.max(img.naturalWidth, img.naturalHeight) <= 1000;
    let full;
    let thumb = null;
    try {
      full = await encode(img, 1000, MAX_IMAGE_BYTES);
      thumb = await encode(img, 240, MAX_THUMB_BYTES);
    } catch (error) {
      if (!reusable) throw error;
      full = { bytes: original, width: img.naturalWidth, height: img.naturalHeight };
      // 通常画像を一覧用として複製しない。一覧はプレースホルダー、詳細で原画像を表示。
    }
    return { full, thumb, revision: crypto.randomUUID() };
  } finally { URL.revokeObjectURL(url); }
}
