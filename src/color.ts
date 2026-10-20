export const DEFAULT_HIGHLIGHT_COLOR = '#ff00ff';
export const HIGHLIGHT_OPACITY = 0.65;

/** Restrict rendering colors to RGB hex, also safe for the offline HTML legend. */
export function parseHighlightColor(value: unknown = DEFAULT_HIGHLIGHT_COLOR): {
  hex: string; rgb: [number, number, number];
} {
  if (typeof value !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) {
    throw new Error('Highlight color must be a hex RGB color (#RGB or #RRGGBB), for example "#00ff00".');
  }
  const digits = value.slice(1).toLowerCase();
  const full = digits.length === 3 ? [...digits].map(digit => digit + digit).join('') : digits;
  return { hex: '#' + full, rgb: [0, 2, 4].map(offset => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number] };
}
