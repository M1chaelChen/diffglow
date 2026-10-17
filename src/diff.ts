import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';

const MAX_PIXELS = 25_000_000;
const HIGHLIGHT = [255, 0, 255] as const;
const HIGHLIGHT_OPACITY = 0.65;

export interface DiffOptions {
  output?: string;
  threshold?: number;
}

export interface Dimensions {
  width: number;
  height: number;
}

export interface DiffResult extends Dimensions {
  before: Dimensions;
  after: Dimensions;
  dimensionsChanged: boolean;
  changedPixels: number;
  comparedPixels: number;
  changedPercentage: number;
  outputPath: string;
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
async function assertSafeOutput(output: string, inputs: string[]): Promise<void> {
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
    const inputStat = await stat(input);
    if (
      output === input || outputReal === input ||
      (outputStat && outputStat.dev === inputStat.dev && outputStat.ino === inputStat.ino)
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

function highlight(data: Buffer, offset: number): void {
  const backgroundAlpha = data[offset + 3] / 255;
  const alpha = HIGHLIGHT_OPACITY + backgroundAlpha * (1 - HIGHLIGHT_OPACITY);
  for (let channel = 0; channel < 3; channel++) {
    data[offset + channel] = Math.round((
      HIGHLIGHT[channel] * HIGHLIGHT_OPACITY +
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
  const threshold = options.threshold ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('Threshold must be a finite number between 0 and 1.');
  }
  const [beforeFile, afterFile] = await Promise.all([inputFile(beforePath), inputFile(afterPath)]);
  const outputPath = path.resolve(options.output ?? 'diff.png');
  await assertSafeOutput(outputPath, [beforeFile, afterFile]);
  const [before, after] = await Promise.all([decode(beforeFile), decode(afterFile)]);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  if (width * height > MAX_PIXELS) {
    throw new Error(`Combined image exceeds the ${MAX_PIXELS.toLocaleString('en-US')}-pixel limit.`);
  }
  const beforePixels = align(before, width, height);
  const afterPixels = align(after, width, height);
  const mask = Buffer.alloc(width * height * 4);
  pixelmatch(beforePixels, afterPixels, mask, width, height, {
    threshold, includeAA: false, diffMask: true, diffColor: [...HIGHLIGHT]
  });
  const highlighted = Buffer.from(afterPixels);
  let changedPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const inBefore = x < before.width && y < before.height;
      const inAfter = x < after.width && y < after.height;
      if (!inBefore && !inAfter) continue;
      // Size changes always count, including transparent added/removed areas.
      const changed = inBefore !== inAfter || mask[offset + 3] !== 0;
      if (!changed) continue;
      if (inBefore && !inAfter) beforePixels.copy(highlighted, offset, offset, offset + 4);
      highlight(highlighted, offset);
      changedPixels++;
    }
  }
  const comparedPixels = before.width * before.height + after.width * after.height -
    Math.min(before.width, after.width) * Math.min(before.height, after.height);
  // Check again immediately before replacing an existing destination.
  await assertSafeOutput(outputPath, [beforeFile, afterFile]);
  try {
    await savePNG(highlighted, width, height, outputPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot write output "${outputPath}": ${detail}`);
  }
  return {
    width, height,
    before: { width: before.width, height: before.height },
    after: { width: after.width, height: after.height },
    dimensionsChanged: before.width !== after.width || before.height !== after.height,
    changedPixels,
    comparedPixels,
    changedPercentage: changedPixels / comparedPixels * 100,
    outputPath
  };
}
