import type { PairResult } from './diff.js';
import { HIGHLIGHT_OPACITY } from './color.js';
import { portablePath } from './paths.js';

/** Versioned CLI report; percentages retain their unrounded comparison precision. */
export function comparisonReport(result: PairResult, exitCode: 0 | 1, paths: {
  relative?: boolean; before?: string; after?: string; output?: string;
} = {}) {
  const present = (filename: string): string => paths.relative ? portablePath(filename) : filename;
  const status = result.before === null ? 'added' as const : result.after === null ? 'removed' as const :
    result.changedPixels > 0 ? 'different' as const : 'identical' as const;
  return {
    schemaVersion: 1 as const,
    status,
    before: result.before ? { path: paths.before ?? present(result.beforePath!), ...result.before } : null,
    after: result.after ? { path: paths.after ?? present(result.afterPath!), ...result.after } : null,
    output: { path: paths.output ?? present(result.outputPath), width: result.width, height: result.height },
    rendering: { highlightColor: result.highlightColor, highlightOpacity: HIGHLIGHT_OPACITY },
    comparison: {
      threshold: result.threshold,
      includeAntiAliasing: false,
      alignment: 'top-left',
      ignoreRegions: result.ignoreRegions,
      dimensionsChanged: result.dimensionsChanged
    },
    stats: {
      comparedPixels: result.comparedPixels,
      ignoredPixels: result.ignoredPixels,
      changedPixels: result.changedPixels,
      unchangedPixels: result.unchangedPixels,
      changedPercentage: result.changedPercentage,
      modifiedPixels: result.modifiedPixels,
      addedPixels: result.addedPixels,
      removedPixels: result.removedPixels,
      diffBounds: result.diffBounds
    },
    exitCode
  };
}

export function errorReport(message: string) {
  return { schemaVersion: 1 as const, status: 'error' as const, error: { message }, exitCode: 2 as const };
}
