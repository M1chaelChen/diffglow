import { createHash } from 'node:crypto';
import { copyFile, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeOutput, comparePair } from './diff.js';
import { canonicalPath, contains, type InputSelection } from './discovery.js';
import { prepareReport } from './output.js';
import { comparisonReport, errorReport } from './report.js';
import { htmlReport } from './html.js';

export interface Artifacts { baseline: string | null; current: string | null; diff: string }
export type SuccessEntry = ReturnType<typeof comparisonReport> & { id: string; artifacts: Artifacts };
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
  comparison: { threshold: number; includeAntiAliasing: false; alignment: 'top-left' };
  summary: {
    total: number; compared: number; different: number; identical: number; added: number; removed: number; errors: number;
    comparedPixels: number; changedPixels: number; unchangedPixels: number; modifiedPixels: number; addedPixels: number; removedPixels: number; changedPercentage: number;
  };
  results: Entry[];
  exitCode: 0 | 1 | 2;
}

export async function runComparisons(selection: InputSelection, options: {
  outputDirectory: string; html: boolean; failOnDiff: boolean; singleOutput?: string;
}): Promise<RunReport> {
  const inputs = selection.pairs.flatMap(pair => [pair.before, pair.after].filter((file): file is string => file !== null));
  const directory = await prepareReport(options.outputDirectory, inputs, selection.inputRoots);
  try {
    if (options.singleOutput) {
      const output = await canonicalPath(options.singleOutput);
      if (contains(output, directory.directory)) throw new Error('The PNG output must not contain the HTML report directory.');
      const canonicalInputs = await Promise.all(inputs.map(input => realpath(input).catch(() => path.resolve(input))));
      await assertSafeOutput(output, canonicalInputs);
    }
    const results: Entry[] = [];
    for (const pair of selection.pairs) {
      const hash = createHash('sha256').update(pair.id).digest('hex');
      const asset = `assets/${hash}`;
      const stagedAssets = path.join(directory.staging, 'assets', hash);
      const artifacts: Artifacts = {
        baseline: options.html && pair.before !== null ? `${asset}/baseline.png` : null,
        current: options.html && pair.after !== null ? `${asset}/current.png` : null,
        diff: `${asset}/diff.png`
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
          output, threshold: selection.threshold,
          ...(options.html ? { previews: { baseline: path.join(stagedAssets, 'baseline.png'), current: path.join(stagedAssets, 'current.png') } } : {})
        });
        if (output !== stagedDiff) await copyFile(output, stagedDiff);
        const exitCode = options.failOnDiff && result.changedPixels > 0 ? 1 : 0;
        results.push({ id: pair.id, ...comparisonReport({ ...result, outputPath: reportedOutput }, exitCode), artifacts });
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replaceAll(directory.staging, directory.directory);
        results.push({ id: pair.id, ...errorReport(message),
          inputs: { before: pair.before, after: pair.after }, artifacts: null });
        // Failed pairs must not retain previews that could look like completed results.
        await rm(stagedAssets, { recursive: true, force: true });
      }
    }
    const summary: RunReport['summary'] = {
      total: results.length, compared: 0, different: 0, identical: 0, added: 0, removed: 0, errors: 0,
      comparedPixels: 0, changedPixels: 0, unchangedPixels: 0, modifiedPixels: 0, addedPixels: 0, removedPixels: 0, changedPercentage: 0
    };
    for (const result of results) {
      if (result.status === 'error') { summary.errors++; continue; }
      summary[result.status]++;
      summary.compared++;
      for (const field of ['comparedPixels', 'changedPixels', 'unchangedPixels', 'modifiedPixels', 'addedPixels', 'removedPixels'] as const) summary[field] += result.stats[field];
    }
    summary.changedPercentage = summary.comparedPixels ? summary.changedPixels / summary.comparedPixels * 100 : 0;
    const hasChanges = summary.different + summary.added + summary.removed > 0;
    const report: RunReport = {
      tool: 'diffglow', schemaVersion: 1, mode: selection.mode,
      status: summary.errors ? 'error' : hasChanges ? 'different' : 'identical',
      outputDirectory: directory.directory,
      htmlReportPath: options.html ? path.join(directory.directory, 'index.html') : null,
      comparison: { threshold: selection.threshold, includeAntiAliasing: false, alignment: 'top-left' },
      summary, results,
      exitCode: summary.errors ? 2 : options.failOnDiff && hasChanges ? 1 : 0
    };
    await writeFile(path.join(directory.staging, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    if (options.html) await writeFile(path.join(directory.staging, 'index.html'), htmlReport(report));
    await directory.publish();
    return report;
  } finally { await directory.discard(); }
}
