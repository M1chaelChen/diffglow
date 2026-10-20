import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { HIGHLIGHT_OPACITY, parseHighlightColor } from './color.js';

const MAX_PIXELS = 25_000_000;
const MASK_COLOR = [255, 0, 255] as const;

export interface DiffOptions {
  output?: string;
  threshold?: number;
  highlightColor?: string;
  previews?: { baseline: string; current: string };
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface DiffBounds extends Dimensions {
  x: number;
  y: number;
}

export interface PairResult extends Dimensions {
  beforePath: string | null;
  afterPath: string | null;
  before: Dimensions | null;
  after: Dimensions | null;
  dimensionsChanged: boolean;
  threshold: number;
  highlightColor: string;
  changedPixels: number;
  unchangedPixels: number;
  modifiedPixels: number;
  addedPixels: number;
  removedPixels: number;
  comparedPixels: number;
  changedPercentage: number;
  diffBounds: DiffBounds | null;
  outputPath: string;
}

export interface DiffResult extends PairResult {
  beforePath: string;
  afterPath: string;
  before: Dimensions;
  after: Dimensions;
}

interface Image extends Dimensions {
  data: Buffer;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function inputFile(filename: string): Promise<string> {
  try {
    const canonical = await realpath(filename);
    if (!(await stat(canonical)).isFile()) {
      throw new Error('expected an image file');
    }
    return canonical;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read input "${filename}": ${detail}`);
  }
}

// Resolve aliases and hard links before writing, rather than comparing only strings.
export async function assertSafeOutput(output: string, inputs: string[]): Promise<void> {
  if (path.extname(output).toLowerCase() !== '.png') {
    throw new Error('Output must have a .png extension.');
  }
  let outputStat;
  let outputReal;
  try {
    outputReal = await realpath(output);
    outputStat = await stat(output);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  for (const input of inputs) {
    let inputStat;
    try { inputStat = await stat(input); } catch (error) { if (!isMissing(error)) throw error; }
    if (
      output === input || outputReal === input ||
      (outputStat && inputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)
    ) {
      throw new Error('Output must not overwrite either input image.');
    }
  }
}

async function decode(filename: string): Promise<Image> {
  try {
    const image = sharp(filename, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' && metadata.format !== 'jpeg') {
      throw new Error('only PNG and JPEG inputs are supported');
    }
    if ((metadata.pages ?? 1) > 1) {
      throw new Error('animated or multi-page images are not supported');
    }
    const { data, info } = await image.autoOrient().toColourspace('srgb')
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot decode "${filename}" as a screenshot: ${detail}`);
  }
}

function align(image: Image, width: number, height: number): Buffer {
  if (image.width === width && image.height === height) return image.data;
  const result = Buffer.alloc(width * height * 4);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y++) {
    image.data.copy(result, y * width * 4, y * rowBytes, (y + 1) * rowBytes);
  }
  return result;
}

function highlight(data: Buffer, offset: number, color: readonly [number, number, number]): void {
  const backgroundAlpha = data[offset + 3] / 255;
  const alpha = HIGHLIGHT_OPACITY + backgroundAlpha * (1 - HIGHLIGHT_OPACITY);
  for (let channel = 0; channel < 3; channel++) {
    data[offset + channel] = Math.round((
      color[channel] * HIGHLIGHT_OPACITY +
      data[offset + channel] * backgroundAlpha * (1 - HIGHLIGHT_OPACITY)
    ) / alpha);
  }
  data[offset + 3] = Math.round(alpha * 255);
}

async function savePNG(data: Buffer, width: number, height: number, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.diffglow-${randomUUID()}.tmp`);
  try {
    const png = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
    await writeFile(temporary, png, { flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
}

/** Compare normalized pixels and write highlights over the second screenshot. */
export async function diffScreenshots(
  beforePath: string,
  afterPath: string,
  options: DiffOptions = {}
): Promise<DiffResult> {
  return comparePair(beforePath, afterPath, options) as Promise<DiffResult>;
}

/** Missing sides are explicit folder additions/removals, never failed reads. */
export async function comparePair(
  beforePath: string | null,
  afterPath: string | null,
  options: DiffOptions = {}
): Promise<PairResult> {
  const { hex: highlightColor, rgb } = parseHighlightColor(options.highlightColor);
  const threshold = options.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Threshold must be a finite number between 0 and 1.');
  }
  if (beforePath === null && afterPath === null) throw new Error('A comparison requires at least one image.');
  const [beforeFile, afterFile] = await Promise.all([
    beforePath === null ? null : inputFile(beforePath), afterPath === null ? null : inputFile(afterPath)
  ]);
  const inputs = [beforeFile, afterFile].filter((file): file is string => file !== null);
  const outputPath = path.resolve(options.output ?? 'diff.png');
  await assertSafeOutput(outputPath, inputs);
  if (options.previews) {
    for (const preview of Object.values(options.previews)) await assertSafeOutput(path.resolve(preview), inputs);
    const destinations = [outputPath, ...Object.values(options.previews).map(file => path.resolve(file))];
    if (new Set(destinations).size !== destinations.length) throw new Error('Preview and diff output paths must be distinct.');
  }
  const [before, after] = await Promise.all([beforeFile === null ? null : decode(beforeFile), afterFile === null ? null : decode(afterFile)]);
  const width = Math.max(before?.width ?? 0, after?.width ?? 0);
  const height = Math.max(before?.height ?? 0, after?.height ?? 0);
  if (width * height > MAX_PIXELS) {
    throw new Error(`Combined image exceeds the ${MAX_PIXELS.toLocaleString('en-US')}-pixel limit.`);
  }
  const beforePixels = before ? align(before, width, height) : Buffer.alloc(width * height * 4);
  const afterPixels = after ? align(after, width, height) : Buffer.alloc(width * height * 4);
  const mask = Buffer.alloc(width * height * 4);
  if (before && after) pixelmatch(beforePixels, afterPixels, mask, width, height, {
    threshold, includeAA: false, diffMask: true, diffColor: [...MASK_COLOR]
  });
  const highlighted = Buffer.from(afterPixels);
  let changedPixels = 0;
  let modifiedPixels = 0;
  let addedPixels = 0;
  let removedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const inBefore = before !== null && x < before.width && y < before.height;
      const inAfter = after !== null && x < after.width && y < after.height;
      if (!inBefore && !inAfter) continue;
      // Size changes always count, including transparent added/removed areas.
      const changed = inBefore !== inAfter || mask[offset + 3] !== 0;
      if (!changed) continue;
      if (inBefore && !inAfter) beforePixels.copy(highlighted, offset, offset, offset + 4);
      highlight(highlighted, offset, rgb);
      changedPixels++;
      if (inBefore && inAfter) modifiedPixels++;
      else if (inAfter) addedPixels++;
      else removedPixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const comparedPixels = (before ? before.width * before.height : 0) + (after ? after.width * after.height : 0) -
    Math.min(before?.width ?? 0, after?.width ?? 0) * Math.min(before?.height ?? 0, after?.height ?? 0);
  // Check again immediately before replacing an existing destination.
  await assertSafeOutput(outputPath, inputs);
  try {
    await savePNG(highlighted, width, height, outputPath);
    if (options.previews) {
      for (const [image, filename] of [[before, options.previews.baseline], [after, options.previews.current]] as const) {
        if (!image) continue;
        await assertSafeOutput(path.resolve(filename), inputs);
        await savePNG(image.data, image.width, image.height, filename);
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot write output "${outputPath}": ${detail}`);
  }
  return {
    width, height,
    beforePath: beforeFile,
    afterPath: afterFile,
    before: before ? { width: before.width, height: before.height } : null,
    after: after ? { width: after.width, height: after.height } : null,
    dimensionsChanged: before?.width !== after?.width || before?.height !== after?.height,
    threshold,
    highlightColor,
    changedPixels,
    unchangedPixels: comparedPixels - changedPixels,
    modifiedPixels,
    addedPixels,
    removedPixels,
    comparedPixels,
    changedPercentage: changedPixels / comparedPixels * 100,
    diffBounds: changedPixels === 0 ? null : {
      x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1
    },
    outputPath
  };
}
