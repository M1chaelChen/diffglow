import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const MAX_PIXELS = 25_000_000;
const MAX_WEBP_DIMENSION = 16_383;

export interface ReportImageOptions {
  maxHeight: number | null;
  imageFormat: 'png' | 'webp';
}

/** Report presentation settings never change the pixels used for comparison. */
export function normalizeReportImages(options: {
  maxHeight?: unknown; imageFormat?: unknown;
} = {}): ReportImageOptions {
  const { maxHeight, imageFormat = 'png' } = options;
  if (maxHeight !== undefined && (typeof maxHeight !== 'number' || !Number.isSafeInteger(maxHeight) || maxHeight <= 0)) {
    throw new Error('Report max height must be a positive safe integer.');
  }
  if (imageFormat !== 'png' && imageFormat !== 'webp') {
    throw new Error('Report image format must be "png" or "webp".');
  }
  return { maxHeight: maxHeight === undefined ? null : maxHeight as number, imageFormat };
}

/** Encode report assets only; the source can be a generated PNG at the destination. */
export async function renderReportImage(
  source: string, destination: string, options: ReportImageOptions
): Promise<{ width: number; height: number }> {
  const normalized = normalizeReportImages({
    maxHeight: options.maxHeight === null ? undefined : options.maxHeight,
    imageFormat: options.imageFormat
  });
  const pipeline = sharp(source, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height) throw new Error('Report image has no pixel dimensions.');
  const height = Math.min(metadata.height, normalized.maxHeight ?? metadata.height);
  const width = Math.max(1, Math.round(metadata.width * height / metadata.height));
  if (normalized.imageFormat === 'webp' && Math.max(width, height) > MAX_WEBP_DIMENSION) {
    throw new Error(`WebP report images must be at most ${MAX_WEBP_DIMENSION} pixels wide or high. Use a smaller --max-height or PNG output.`);
  }

  let data: Buffer;
  let dimensions = { width: metadata.width, height: metadata.height };
  if (normalized.imageFormat === 'png' && metadata.format === 'png' && height === metadata.height) {
    // Preserve the original bytes and avoid an unnecessary PNG decode/encode.
    if (path.resolve(source) === path.resolve(destination)) return dimensions;
    data = await readFile(source);
  } else {
    if (height < metadata.height) pipeline.resize({ height, withoutEnlargement: true });
    if (normalized.imageFormat === 'webp') pipeline.webp({ lossless: true, exact: true });
    else pipeline.png();
    const encoded = await pipeline.toBuffer({ resolveWithObject: true });
    data = encoded.data;
    dimensions = { width: encoded.info.width, height: encoded.info.height };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.diffglow-report-image-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    });
  }
  return dimensions;
}
