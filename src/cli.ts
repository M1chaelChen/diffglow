#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { diffScreenshots } from './diff.js';
import { selectInputs } from './discovery.js';
import { runComparisons, type SuccessEntry } from './batch.js';
import { comparisonReport, errorReport } from './report.js';
import { parseIgnoreRegion } from './regions.js';
import { portablePath, relativeError } from './paths.js';
import { normalizeReportImages } from './report-images.js';

const HELP = `Usage: diffglow <before.png|jpg> <after.png|jpg> [options]
       diffglow <baseline-folder> <current-folder> [options]
       diffglow <screenshot-root> [options]
       diffglow --manifest <pairs.json> [options]

Highlights changed pixels over the current screenshot (magenta by default).
A screenshot root contains baseline/ and current/ (or diffglow.config.json).

Options:
  -o, --output <path>      Single-pair output PNG (default: diff.png)
      --output-dir <dir>  Batch/HTML report directory (default: diffglow-report)
      --manifest <file>   JSON manifest of named before/after pairs
      --config <file>     JSON folder names, globs, templates, and threshold
      --html              Generate an offline HTML report and image assets
      --relative          Portable paths in text, JSON, and HTML (safe to move)
      --max-height <px>   Limit report image height; compare original pixels
      --image-format <png|webp>  Report assets (default: png; WebP is lossless)
      --threshold <0..1>  Per-pixel color tolerance (default: 0.1)
      --highlight-color <hex>  Highlight #RGB or #RRGGBB (default: #ff00ff)
      --ignore-region <x,y,width,height>  Ignore a pixel rectangle; repeatable
      --fail-on-diff      Exit 1 on changes after writing outputs
      --json              Write detailed JSON to stdout instead of text
  -h, --help              Show this help
  -v, --version           Show the installed version

Exit codes: 0 = completed/help/version, 1 = differences with --fail-on-diff, 2 = error
`;

function printComparison(result: ReturnType<typeof comparisonReport>, outputPath = result.output.path) {
  const percentage = result.stats.changedPercentage.toFixed(6).replace(/\.?0+$/, '');
  const noun = result.stats.changedPixels === 1 ? 'pixel' : 'pixels';
  console.log(`${result.stats.changedPixels.toLocaleString('en-US')} changed ${noun} (${percentage}%).`);
  if (result.comparison.ignoreRegions.length) console.log(`${result.stats.ignoredPixels.toLocaleString('en-US')} ignored pixels; ${result.stats.comparedPixels.toLocaleString('en-US')} compared pixels.`);
  if (result.stats.comparedPixels === 0) console.log('No pixels compared: ignore regions cover the entire image area.');
  if (result.comparison.dimensionsChanged && result.before && result.after) {
    console.log(`Dimensions: ${result.before.width}×${result.before.height} → ` +
      `${result.after.width}×${result.after.height}; aligned at top-left without resizing.`);
  }
  console.log(`Highlighted image: ${outputPath}`);
}
function singleReport(entry: SuccessEntry) {
  const { id: _id, artifacts: _artifacts, ...report } = entry;
  return report;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  // Argument errors stay machine-readable; positional filenames are not options.
  let json = (separator < 0 ? args : args.slice(0, separator)).includes('--json');
  let relative = (separator < 0 ? args : args.slice(0, separator)).includes('--relative');
  const knownPaths: string[] = [...args];
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        'output-dir': { type: 'string' }, manifest: { type: 'string' }, config: { type: 'string' },
        html: { type: 'boolean', default: false },
        relative: { type: 'boolean', default: false },
        'max-height': { type: 'string' }, 'image-format': { type: 'string' },
        threshold: { type: 'string' },
        'highlight-color': { type: 'string' },
        'ignore-region': { type: 'string', multiple: true },
        'fail-on-diff': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false }
      }
    });
    json = values.json;
    relative = values.relative;
    const displayPath = (filename: string): string => relative ? portablePath(filename) : filename;
    if (values.help) { console.log(HELP); return 0; }
    if (values.version) {
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      console.log(metadata.version); return 0;
    }
    if (values.threshold !== undefined && values.threshold.trim() === '') throw new Error('Threshold must be a finite number between 0 and 1.');
    for (const flag of ['output-dir', 'config', 'manifest'] as const) {
      if (values[flag] !== undefined && !values[flag].trim()) throw new Error(`--${flag} requires a nonempty path.`);
    }
    const outputDirectory = path.resolve(values['output-dir'] ?? 'diffglow-report');
    const imageOptions = normalizeReportImages({
      maxHeight: values['max-height'] === undefined ? undefined : Number(values['max-height']),
      imageFormat: values['image-format']
    });
    const selection = await selectInputs(positionals, {
      manifest: values.manifest, config: values.config,
      highlightColor: values['highlight-color'],
      ignoreRegions: values['ignore-region']?.map(parseIgnoreRegion),
      threshold: values.threshold === undefined ? undefined : Number(values.threshold), outputDirectory
    });
    knownPaths.push(outputDirectory, path.resolve(values.output ?? 'diff.png'), ...selection.inputRoots, ...selection.pairs.flatMap(pair => [pair.before, pair.after].filter((file): file is string => file !== null)));
    if (selection.mode === 'batch' && values.output !== undefined) throw new Error('Use --output-dir for batch comparisons; --output is a single PNG path.');
    if (selection.mode === 'single' && !values.html && values['output-dir'] !== undefined) throw new Error('--output-dir requires batch inputs or --html.');
    if (selection.mode === 'single' && !values.html && (values['max-height'] !== undefined || values['image-format'] !== undefined)) throw new Error('--max-height and --image-format require batch inputs or --html; --output remains a full-resolution PNG.');
    if (selection.mode === 'single' && !values.html) {
      const pair = selection.pairs[0];
      const result = await diffScreenshots(pair.before!, pair.after!, {
        output: values.output, threshold: selection.threshold, highlightColor: selection.highlightColor, ignoreRegions: pair.ignoreRegions ?? selection.ignoreRegions
      });
      const exitCode = values['fail-on-diff'] && result.changedPixels > 0 ? 1 : 0;
      const report = comparisonReport(result, exitCode, { relative });
      if (json) console.log(JSON.stringify(report, null, 2));
      else printComparison(report);
      return exitCode;
    }
    const report = await runComparisons(selection, {
      outputDirectory, html: values.html, failOnDiff: values['fail-on-diff'],
      relative, ...(imageOptions.maxHeight === null ? {} : { maxHeight: imageOptions.maxHeight }), imageFormat: imageOptions.imageFormat,
      ...(selection.mode === 'single' ? { singleOutput: path.resolve(values.output ?? 'diff.png') } : {})
    });
    if (selection.mode === 'single') {
      const entry = report.results[0];
      if (entry.status === 'error') {
        if (json) console.log(JSON.stringify(errorReport(entry.error.message), null, 2));
        else { console.error(`Error: ${entry.error.message}`); console.log(`HTML report: ${displayPath(path.join(outputDirectory, 'index.html'))}`); }
      } else {
        const payload = singleReport(entry);
        if (json) console.log(JSON.stringify(payload, null, 2));
        else { printComparison(payload, displayPath(path.resolve(values.output ?? 'diff.png'))); console.log(`HTML report: ${displayPath(path.join(outputDirectory, 'index.html'))}`); }
      }
    } else if (json) console.log(JSON.stringify(report, null, 2));
    else {
      const s = report.summary;
      console.log(`${s.total} comparisons: ${s.different} changed, ${s.identical} identical, ${s.added} added, ${s.removed} removed, ${s.errors} errors.`);
      console.log(`${s.changedPixels.toLocaleString('en-US')} changed pixels (${s.changedPercentage.toFixed(6).replace(/\.?0+$/, '')}%).`);
      if (s.ignoredPixels > 0 || report.comparison.ignoreRegions.length) console.log(`${s.ignoredPixels.toLocaleString('en-US')} ignored pixels; ${s.comparedPixels.toLocaleString('en-US')} compared pixels.`);
      if (s.compared > 0 && s.comparedPixels === 0) console.log('No pixels compared: ignore regions cover the entire image area.');
      for (const entry of report.results) if (entry.status === 'error') console.error(`Error [${entry.id}]: ${entry.error.message}`);
      console.log(`JSON results: ${displayPath(path.join(outputDirectory, 'results.json'))}`);
      if (report.htmlReportPath) console.log(`HTML report: ${displayPath(path.join(outputDirectory, 'index.html'))}`);
    }
    return report.exitCode;
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    const message = relative ? relativeError(originalMessage, knownPaths) : originalMessage;
    if (json) console.log(JSON.stringify(errorReport(message), null, 2));
    else console.error(`Error: ${message}`);
    return 2;
  }
}

process.exitCode = await main();
