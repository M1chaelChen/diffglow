export interface IgnoreRegion { x: number; y: number; width: number; height: number }

const message = 'Ignore regions require x,y,width,height: nonnegative integer x/y and positive integer width/height, within the safe integer range.';

/** Validate before reading images or creating any output; return independent values. */
export function parseIgnoreRegions(value: unknown = []): IgnoreRegion[] {
  if (!Array.isArray(value)) throw new Error(message);
  return value.map(region => {
    if (typeof region !== 'object' || region === null || Array.isArray(region) ||
        Object.keys(region).length !== 4 || Object.keys(region).some(key => !['x', 'y', 'width', 'height'].includes(key))) {
      throw new Error(message);
    }
    const { x, y, width, height } = region as IgnoreRegion;
    if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 || width <= 0 || height <= 0 ||
        !Number.isSafeInteger(x + width) || !Number.isSafeInteger(y + height)) throw new Error(message);
    return { x, y, width, height };
  });
}

export function parseIgnoreRegion(value: string): IgnoreRegion {
  const parts = value.split(',').map(part => part.trim());
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part))) throw new Error(message);
  const [x, y, width, height] = parts.map(Number);
  return parseIgnoreRegions([{ x, y, width, height }])[0];
}

/** Clip before filling; overlaps remain a single byte per ignored pixel. */
export function ignoreMask(regions: IgnoreRegion[], width: number, height: number): Uint8Array | undefined {
  const clipped = regions.map(region => ({
    x: region.x, y: region.y,
    right: Math.min(width, region.x + region.width), bottom: Math.min(height, region.y + region.height)
  })).filter(region => region.x < region.right && region.y < region.bottom);
  if (!clipped.length) return undefined;
  const mask = new Uint8Array(width * height);
  for (const region of clipped) for (let y = region.y; y < region.bottom; y++) {
    mask.fill(1, y * width + region.x, y * width + region.right);
  }
  return mask;
}
