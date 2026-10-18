import type { PairResult } from './diff.js';

/** Versioned CLI report; percentages retain their unrounded comparison precision. */
export function comparisonReport(result: PairResult, exitCode: 0 | 1) {
  const status = result.before === null ? 'added' as const : result.after === null ? 'removed' as const :
    result.changedPixels > 0 ? 'different' as const : 'identical' as const;
  return {
    schemaVersion: 1 as const,
    status,
    before: result.before ? { path: result.beforePath!, ...result.before } : null,
    after: result.after ? { path: result.afterPath!, ...result.after } : null,
    output: { path: result.outputPath, width: result.width, height: result.height },
    comparison: {
      threshold: result.threshold,
      includeAntiAliasing: false,
      alignment: 'top-left',
      dimensionsChanged: result.dimensionsChanged
    },
    stats: {
      comparedPixels: result.comparedPixels,
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
