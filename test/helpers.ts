import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import sharp from 'sharp';

export async function workspace(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'screenshot diff-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function pixels(width: number, height: number, color = [255, 255, 255, 255]): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    for (let channel = 0; channel < 4; channel++) data[i + channel] = color[channel];
  }
  return data;
}

export async function image(filename: string, width: number, height: number, data = pixels(width, height)) {
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(filename);
}

export async function readPixels(filename: string): Promise<Buffer> {
  return sharp(filename).ensureAlpha().raw().toBuffer();
}

export function pixel(data: Buffer, width: number, x: number, y: number): number[] {
  return [...data.subarray((y * width + x) * 4, (y * width + x + 1) * 4)];
}
