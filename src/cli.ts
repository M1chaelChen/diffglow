#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { diffScreenshots } from './diff.js';

const HELP = `Usage: diffglow <before.png|jpg> <after.png|jpg> [options]

Highlights changed pixels in magenta over the second screenshot.

Options:
  -o, --output <path>      Output PNG path (default: diff.png)
      --threshold <0..1>  Per-pixel color tolerance (default: 0.1)
      --fail-on-diff      Exit 1 when pixels differ; the PNG is still written
  -h, --help              Show this help
  -v, --version           Show the installed version

Exit codes: 0 = image written/help/version, 1 = differences with --fail-on-diff, 2 = error
`;

async function main(): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        threshold: { type: 'string' },
        'fail-on-diff': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false }
      }
    });
    if (values.help) {
      console.log(HELP);
      return 0;
    }
    if (values.version) {
      const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      console.log(metadata.version);
      return 0;
    }
    if (positionals.length !== 2) {
      throw new Error('Provide exactly two input images. Use --help for usage.');
    }
    if (values.threshold !== undefined && values.threshold.trim() === '') {
      throw new Error('Threshold must be a finite number between 0 and 1.');
    }
    const result = await diffScreenshots(positionals[0], positionals[1], {
      output: values.output,
      threshold: values.threshold === undefined ? undefined : Number(values.threshold)
    });
    const percentage = result.changedPercentage.toFixed(6).replace(/\.?0+$/, '');
    const noun = result.changedPixels === 1 ? 'pixel' : 'pixels';
    console.log(`${result.changedPixels.toLocaleString('en-US')} changed ${noun} (${percentage}%).`);
    if (result.dimensionsChanged) {
      console.log(`Dimensions: ${result.before.width}×${result.before.height} → ` +
        `${result.after.width}×${result.after.height}; aligned at top-left without resizing.`);
    }
    console.log(`Highlighted image: ${result.outputPath}`);
    return values['fail-on-diff'] && result.changedPixels > 0 ? 1 : 0;
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

process.exitCode = await main();
