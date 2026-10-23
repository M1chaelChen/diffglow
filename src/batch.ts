import { createHash } from 'node:crypto';
import { copyFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeOutput, comparePair } from './diff.js';
import { canonicalPath, contains, type InputSelection } from './discovery.js';
import { prepareReport } from './output.js';
import { comparisonReport, errorReport } from './report.js';
import { htmlReport } from './html.js';
import { HIGHLIGHT_OPACITY } from './color.js';
import { parseIgnoreRegions, type IgnoreRegion } from './regions.js';
import { portablePath, relativeError } from './paths.js';
import { normalizeReportImages, renderReportImage, type ReportImageOptions } from './report-images.js';

export interface Artifacts { baseline: string | null; current: string | null; diff: string }
interface Dimensions { width: number; height: number }
export type SuccessEntry = ReturnType<typeof comparisonReport> & {
  id: string; artifacts: Artifacts;
  reportImages?: ReportImageOptions & {
    dimensions: { baseline: Dimensions | null; current: Dimensions | null; diff: Dimensions };
  };
};
export type ErrorEntry = ReturnType<typeof errorReport> & {
  id: string; inputs: { before: string | null; after: string | null }; artifacts: null;
};
export type Entry = SuccessEntry | ErrorEntry;
export interface RunReport {
  tool: 'diffglow';
  schemaVersion: 1;
  mode: 'single' | 'batch';
  status: 'different' | 'identical' | 'error';
  outputDirectory: string;
  htmlReportPath: string | null;
  comparison: { threshold: number; includeAntiAliasing: false; alignment: 'top-left'; ignoreRegions: IgnoreRegion[] };
  rendering: { highlightColor: string; highlightOpacity: number };
  reportImages?: ReportImageOptions;
  summary: {
    total: number; compared: number; different: number; identical: number; added: number; removed: number; errors: number;
    comparedPixels: number; ignoredPixels: number; changedPixels: number; unchangedPixels: number; modifiedPixels: number; addedPixels: number; removedPixels: number; changedPercentage: number;
  };
  results: Entry[];
  exitCode: 0 | 1 | 2;
}

export async function runComparisons(selection: InputSelection, options: {
  outputDirectory: string; html: boolean; failOnDiff: boolean; singleOutput?: string;
  relative?: boolean; maxHeight?: number; imageFormat?: 'png' | 'webp';
}): Promise<RunReport> {
  const ignoreRegions = parseIgnoreRegions(selection.ignoreRegions);
  const imageOptions = normalizeReportImages(options);
  const customizedImages = imageOptions.maxHeight !== null || imageOptions.imageFormat !== 'png';
  const inputs = selection.pairs.flatMap(pair => [pair.before, pair.after].filter((file): file is string => file !== null));
  const directory = await prepareReport(options.outputDirectory, inputs, selection.inputRoots);
  try {
    if (options.singleOutput) {
      const output = await canonicalPath(options.singleOutput);
      if (contains(output, directory.directory)) throw new Error('The PNG output must not contain the HTML report directory.');
      const relativeOutput = path.relative(directory.directory, output);
      if (contains(path.join(directory.directory, 'assets'), output) || ['index.html', 'results.json', '.diffglow-report'].includes(relativeOutput)) {
        throw new Error('The single PNG output must be outside the generated report assets and reserved report files.');
      }
      const canonicalInputs = await Promise.all(inputs.map(input => realpath(input).catch(() => path.resolve(input))));
      await assertSafeOutput(output, canonicalInputs);
    }
    const results: Entry[] = [];
    for (const pair of selection.pairs) {
      const hash = createHash('sha256').update(pair.id).digest('hex');
      const asset = `assets/${hash}`;
      const stagedAssets = path.join(directory.staging, 'assets', hash);
      const extension = imageOptions.imageFormat;
      const artifacts: Artifacts = {
        baseline: options.html && pair.before !== null ? `${asset}/baseline.${extension}` : null,
        current: options.html && pair.after !== null ? `${asset}/current.${extension}` : null,
        diff: `${asset}/diff.${extension}`
      };
      try {
        await mkdir(stagedAssets, { recursive: true });
        const stagedDiff = path.join(stagedAssets, 'diff.png');
        let output = stagedDiff;
        let reportedOutput = path.join(directory.directory, artifacts.diff);
        if (options.singleOutput) {
          reportedOutput = path.resolve(options.singleOutput);
          const canonicalOutput = await canonicalPath(reportedOutput);
          output = contains(directory.directory, canonicalOutput) ?
            path.join(directory.staging, path.relative(directory.directory, canonicalOutput)) : reportedOutput;
        }
        const result = await comparePair(pair.before, pair.after, {
          output, threshold: selection.threshold, highlightColor: selection.highlightColor, ignoreRegions: pair.ignoreRegions ?? ignoreRegions,
          ...(options.html ? { previews: { baseline: path.join(stagedAssets, 'baseline.png'), current: path.join(stagedAssets, 'current.png') } } : {})
        });
        if (output !== stagedDiff) await copyFile(output, stagedDiff);
        const dimensions = { baseline: null as Dimensions | null, current: null as Dimensions | null, diff: { width: result.width, height: result.height } };
        if (customizedImages) {
          for (const name of ['baseline', 'current', 'diff'] as const) {
            if (!artifacts[name]) continue;
            const source = path.join(stagedAssets, `${name}.png`);
            const destination = path.join(directory.staging, artifacts[name]);
            dimensions[name] = await renderReportImage(source, destination, imageOptions);
            if (source !== destination) await rm(source);
          }
        }
        const portableInput = (side: 'before' | 'after') => {
          const preview = side === 'before' ? artifacts.baseline : artifacts.current;
          return preview ?? `${side === 'before' ? 'baseline' : 'current'}/${portablePath(pair[side]!, path.dirname(pair[side]!))}`;
        };
        const exitCode = options.failOnDiff && result.changedPixels > 0 ? 1 : 0;
        results.push({ id: pair.id, ...comparisonReport({
          ...result, outputPath: reportedOutput,
          ...(!options.singleOutput || options.relative ? dimensions.diff : {})
        }, exitCode, options.relative ? {
          before: pair.before === null ? undefined : portableInput('before'),
          after: pair.after === null ? undefined : portableInput('after'),
          output: artifacts.diff
        } : {}), artifacts,
        ...(customizedImages ? { reportImages: { ...imageOptions, dimensions } } : {}) });
      } catch (error) {
        const originalMessage = (error instanceof Error ? error.message : String(error)).replaceAll(directory.staging, directory.directory);
        const message = options.relative ? relativeError(originalMessage, [...inputs, directory.directory, directory.staging]) : originalMessage;
        results.push({ id: pair.id, ...errorReport(message),
          inputs: { before: pair.before === null ? null : options.relative ? `baseline/${portablePath(pair.before, path.dirname(pair.before))}` : pair.before,
            after: pair.after === null ? null : options.relative ? `current/${portablePath(pair.after, path.dirname(pair.after))}` : pair.after }, artifacts: null });
        // Failed pairs must not retain previews that could look like completed results.
        await rm(stagedAssets, { recursive: true, force: true });
      }
    }
    const summary: RunReport['summary'] = {
      total: results.length, compared: 0, different: 0, identical: 0, added: 0, removed: 0, errors: 0,
      comparedPixels: 0, ignoredPixels: 0, changedPixels: 0, unchangedPixels: 0, modifiedPixels: 0, addedPixels: 0, removedPixels: 0, changedPercentage: 0
    };
    for (const result of results) {
      if (result.status === 'error') { summary.errors++; continue; }
      summary[result.status]++;
      summary.compared++;
      for (const field of ['comparedPixels', 'ignoredPixels', 'changedPixels', 'unchangedPixels', 'modifiedPixels', 'addedPixels', 'removedPixels'] as const) summary[field] += result.stats[field];
    }
    summary.changedPercentage = summary.comparedPixels ? summary.changedPixels / summary.comparedPixels * 100 : 0;
    const hasChanges = summary.changedPixels > 0;
    const report: RunReport = {
      tool: 'diffglow', schemaVersion: 1, mode: selection.mode,
      status: summary.errors ? 'error' : hasChanges ? 'different' : 'identical',
      outputDirectory: options.relative ? '.' : directory.directory,
      htmlReportPath: options.html ? options.relative ? 'index.html' : path.join(directory.directory, 'index.html') : null,
      comparison: { threshold: selection.threshold, includeAntiAliasing: false, alignment: 'top-left', ignoreRegions },
      rendering: { highlightColor: selection.highlightColor, highlightOpacity: HIGHLIGHT_OPACITY },
      ...(customizedImages ? { reportImages: imageOptions } : {}),
      summary, results,
      exitCode: summary.errors ? 2 : options.failOnDiff && hasChanges ? 1 : 0
    };
    await writeFile(path.join(directory.staging, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    if (options.html) await writeFile(path.join(directory.staging, 'index.html'), htmlReport(report));
    await directory.publish();
    return report;
  } finally { await directory.discard(); }
}
