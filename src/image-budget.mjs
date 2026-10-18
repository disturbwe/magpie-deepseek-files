import sharp from "sharp";
import { Semaphore, sha256 } from "./cache.mjs";

// Leave room below both decimal 200 MB and binary 200 MiB interpretations.
export const IMAGE_BUDGET = 190_000_000;
const profiles = [
  { name: "lossless", lossless: true },
  ...[[1600, 90], [1280, 85], [960, 80], [640, 75], [320, 60], [160, 50], [64, 40]]
    .map(([size, quality]) => ({ name: `${size}-${quality}`, size, quality })),
];
const encoders = new Semaphore(2);

export class ImageBudgetError extends Error {}

async function encodeOne(image, profile, signal) {
  signal?.throwIfAborted();
  const metadata = await sharp(image.raw, { animated: true }).metadata();
  // An animation's frames must never be silently discarded by budget reduction.
  if ((metadata.pages ?? 1) > 1) return null;
  if (profile.lossless && metadata.depth !== "uchar") return null;
  let pipeline = sharp(image.raw).keepMetadata();
  if (profile.size) pipeline = pipeline.resize({ width: profile.size, height: profile.size, fit: "inside", withoutEnlargement: true });
  // WebP may discard RGB values behind fully transparent pixels. Use lossless
  // PNG for alpha images so the lossless stage really preserves all channels.
  const png = profile.lossless && metadata.hasAlpha && !(await sharp(image.raw).stats()).isOpaque;
  const raw = await (png ? pipeline.png({ compressionLevel: 6 }) : pipeline.webp(profile.lossless ? { lossless: true, effort: 0 } : { quality: profile.quality, effort: 3, alphaQuality: 100 })).toBuffer();
  signal?.throwIfAborted();
  return { raw, mime: png ? "image/png" : "image/webp" };
}
const encode = (image, profile, signal) => encoders.run(() => encodeOne(image, profile, signal), signal);

// Budget every occurrence, including repeated references. Cache identity includes
// the source and transform profile; only uploaded ID/expiry/size persist on disk.
export async function planImages(images, { budget = IMAGE_BUDGET, cacheGet, cachePut, signal, onMetric = () => {} } = {}) {
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid image budget");
  const originalBytes = images.reduce((sum, item) => sum + item.image.raw.length, 0);
  let bytes = originalBytes;
  if (bytes <= budget) return { images, bytes, originalBytes, changed: 0, omitted: [] };
  const planned = images.map(item => ({ ...item }));
  const variants = new Map();
  let changed = 0;
  async function variant(source, profile) {
    const digest = sha256(`image-budget-v4\0${profile.name}\0${source.digest}`);
    if (variants.has(digest)) return variants.get(digest);
    const pending = (async () => {
      const stored = await cacheGet?.(digest);
      if (stored && Number.isSafeInteger(stored.bytes) && stored.bytes > 0) return { digest, bytes: stored.bytes, materialize: (uploadSignal = signal) => encode(source, profile, uploadSignal) };
      const encoded = await encode(source, profile, signal);
      if (encoded) await cachePut?.(digest, encoded.raw.length);
      return encoded && { digest, bytes: encoded.raw.length, ...encoded };
    })();
    variants.set(digest, pending);
    return pending;
  }
  async function apply(index, profile) {
    signal?.throwIfAborted();
    const source = images[index].image, current = planned[index].image;
    const next = await variant(source, profile);
    if (!next || next.bytes >= (current.bytes ?? current.raw.length)) return;
    bytes += next.bytes - (current.bytes ?? current.raw.length);
    if (current === source) changed++;
    planned[index].image = next;
  }
  // Lossless first for ALL images, including recent ones. This preserves decoded
  // pixels while allowing small, highly compressible new screenshots to stay sharp.
  for (let i = 0; i < images.length && bytes > budget; i += 4) {
    const end = Math.min(i + 4, images.length);
    await Promise.all(Array.from({ length: end - i }, (_, n) => apply(i + n, profiles[0])));
    if (end % 16 === 0) onMetric({ event: "image_budget_progress", processed: end, images: images.length, imageBytes: bytes });
  }
  // Prefer retaining the last four images at full resolution. Only touch them
  // if every historical image has already exhausted the reduction ladder.
  const historical = Math.max(0, images.length - 4);
  for (const [start, end] of [[0, historical], [historical, images.length]]) {
    for (const profile of profiles.slice(1)) {
      for (let i = start; i < end && bytes > budget; i++) await apply(i, profile);
      if (bytes <= budget) break;
    }
    if (bytes <= budget) break;
  }
  const omitted = [];
  while (bytes > budget && planned.length > 1) {
    const oldest = planned.shift();
    bytes -= oldest.image.bytes ?? oldest.image.raw.length;
    omitted.push(oldest);
  }
  if (bytes > budget) throw new ImageBudgetError("The newest image alone exceeds the image budget. Compact the conversation or use a smaller image.");
  onMetric({ event: "image_budget", originalBytes, imageBytes: bytes, images: planned.length, changed, omitted: omitted.length, budget });
  return { images: planned, bytes, originalBytes, changed, omitted };
}
