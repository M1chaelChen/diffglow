import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { comparePair, diffScreenshots } from '../src/diff.js';
import { image, pixel, pixels, readPixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const regionError = /ignore[ -]?(?:regions?|area)|region/i;
const clock = { x: 0, y: 0, width: 12, height: 2 };

function json(cwd: string, args: string[], expected = 0) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args, '--json'], {
    cwd, encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, expected);
  return report;
}

function fillRectangle(data: Buffer, width: number, rectangle: typeof clock, color = [0, 0, 0, 255]) {
  for (let y = rectangle.y; y < rectangle.y + rectangle.height; y++) {
    for (let x = rectangle.x; x < rectangle.x + rectangle.width; x++) data.set(color, (y * width + x) * 4);
  }
}

async function clockPair(directory: string, outsideChange = false) {
  const before = path.join(directory, 'before.png'); const after = path.join(directory, 'after.png');
  const current = pixels(12, 8);
  fillRectangle(current, 12, { x: 2, y: 0, width: 2, height: 2 });
  if (outsideChange) fillRectangle(current, 12, { x: 7, y: 4, width: 2, height: 2 });
  await image(before, 12, 8); await image(after, 12, 8, current);
  return { before, after };
}

async function folderClockPair(directory: string, outsideChange = false) {
  const baseline = path.join(directory, 'baseline'); const current = path.join(directory, 'current');
  await mkdir(baseline); await mkdir(current);
  const pair = await clockPair(directory, outsideChange);
  const before = path.join(baseline, 'phone.png'); const after = path.join(current, 'phone.png');
  await writeFile(before, await readFile(pair.before)); await writeFile(after, await readFile(pair.after));
  return { baseline, current, before, after };
}

test('ignoring a changing mobile clock produces an untouched current screenshot and zero changes', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory);
  const result = await diffScreenshots(before, after, { output: path.join(directory, 'diff.png'), ignoreRegions: [clock] });
  assert.deepEqual(result.ignoreRegions, [clock]);
  assert.equal(result.ignoredPixels, 24);
  assert.equal(result.comparedPixels, 72);
  assert.equal(result.unchangedPixels, 72);
  assert.equal(result.changedPixels, 0);
  assert.equal(result.changedPercentage, 0);
  assert.equal(result.diffBounds, null);
  assert.deepEqual(await readPixels(result.outputPath), await readPixels(after));
});

test('real changes outside an ignored status bar retain their color, counts, and tight bounds', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory, true);
  const result = await diffScreenshots(before, after, {
    output: path.join(directory, 'diff.png'), ignoreRegions: [clock], highlightColor: '#0f0'
  });
  assert.equal(result.changedPixels, 4); assert.equal(result.modifiedPixels, 4);
  assert.equal(result.addedPixels, 0); assert.equal(result.removedPixels, 0);
  assert.equal(result.ignoredPixels, 24); assert.equal(result.comparedPixels, 72);
  assert.equal(result.unchangedPixels, 68); assert.equal(result.changedPercentage, 4 / 72 * 100);
  assert.deepEqual(result.diffBounds, { x: 7, y: 4, width: 2, height: 2 });
  const highlighted = await readPixels(result.outputPath); const original = await readPixels(after);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
    assert.deepEqual(pixel(highlighted, 12, x, y),
      x >= 7 && x < 9 && y >= 4 && y < 6 ? [0, 166, 0, 255] : pixel(original, 12, x, y));
  }
});

test('changing pixels inside a mask cannot change anti-alias classification or highlighting outside it', async t => {
  const directory = await workspace(t);
  const rows = [
    [170, 170, 170, 0, 170, 0], [85, 170, 0, 170, 170, 0],
    [170, 0, 85, 255, 255, 0], [170, 0, 255, 255, 255, 0],
    [0, 85, 255, 170, 255, 0], [255, 255, 85, 255, 255, 255]
  ];
  const baseline = Buffer.from(rows.flat().flatMap(value => [value, value, value, 255]));
  const first = Buffer.from(baseline);
  for (const [x, y, value] of [[1, 0, 85], [5, 1, 85], [3, 4, 0], [4, 4, 0]]) {
    first.set([value, value, value, 255], (y * 6 + x) * 4);
  }
  const second = Buffer.from(first);
  second.set([255, 255, 255, 255], (2 * 6 + 2) * 4);
  second.set([170, 170, 170, 255], (3 * 6 + 2) * 4);
  const before = path.join(directory, 'before.png');
  const afterA = path.join(directory, 'after-a.png'); const afterB = path.join(directory, 'after-b.png');
  await image(before, 6, 6, baseline); await image(afterA, 6, 6, first); await image(afterB, 6, 6, second);
  const ignoreRegions = [{ x: 2, y: 2, width: 1, height: 2 }];
  const a = await diffScreenshots(before, afterA, { output: path.join(directory, 'a.png'), ignoreRegions });
  const b = await diffScreenshots(before, afterB, { output: path.join(directory, 'b.png'), ignoreRegions });
  for (const field of ['changedPixels', 'unchangedPixels', 'modifiedPixels', 'addedPixels', 'removedPixels', 'comparedPixels', 'ignoredPixels', 'changedPercentage', 'diffBounds'] as const) {
    assert.deepEqual(a[field], b[field], field);
  }
  const outputA = await readPixels(a.outputPath); const outputB = await readPixels(b.outputPath);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
    if (x === 2 && (y === 2 || y === 3)) {
      assert.deepEqual(pixel(outputA, 6, x, y), pixel(first, 6, x, y));
      assert.deepEqual(pixel(outputB, 6, x, y), pixel(second, 6, x, y));
    } else assert.deepEqual(pixel(outputA, 6, x, y), pixel(outputB, 6, x, y));
  }
});

test('overlapping and clipped rectangles exclude their union once and wholly off-image rectangles have no effect', async t => {
  const directory = await workspace(t); const before = path.join(directory, 'before.png'); const after = path.join(directory, 'after.png');
  await image(before, 5, 4); await image(after, 5, 4, pixels(5, 4, [0, 0, 0, 255]));
  const regions = [
    { x: 0, y: 0, width: 3, height: 2 },
    { x: 2, y: 1, width: 7, height: 5 },
    { x: 1000000, y: 1000000, width: 1000000, height: 1000000 }
  ];
  const result = await diffScreenshots(before, after, { output: path.join(directory, 'diff.png'), ignoreRegions: regions });
  assert.equal(result.ignoredPixels, 14); assert.equal(result.comparedPixels, 6);
  assert.equal(result.changedPixels, 6); assert.equal(result.changedPercentage, 100);
  assert.equal(result.unchangedPixels, 0);
  const highlighted = await readPixels(result.outputPath);
  assert.deepEqual(pixel(highlighted, 5, 2, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(highlighted, 5, 4, 3), [0, 0, 0, 255]);
  assert.deepEqual(pixel(highlighted, 5, 4, 0), [166, 0, 166, 255]);
});

test('ignored dimension changes count actual image coverage and leave removed ignored areas transparent', async t => {
  const directory = await workspace(t); const before = path.join(directory, 'before.png'); const after = path.join(directory, 'after.png');
  await image(before, 4, 2, pixels(4, 2, [0, 0, 0, 0]));
  await image(after, 2, 4, pixels(2, 4, [0, 0, 0, 0]));
  const result = await diffScreenshots(before, after, {
    output: path.join(directory, 'diff.png'), threshold: 1,
    ignoreRegions: [{ x: 1, y: 1, width: 9, height: 9 }]
  });
  assert.equal(result.dimensionsChanged, true);
  assert.equal(result.ignoredPixels, 5); assert.equal(result.comparedPixels, 7);
  assert.equal(result.changedPixels, 4); assert.equal(result.unchangedPixels, 3);
  assert.equal(result.addedPixels, 2); assert.equal(result.removedPixels, 2); assert.equal(result.modifiedPixels, 0);
  assert.equal(result.changedPercentage, 4 / 7 * 100);
  const highlighted = await readPixels(result.outputPath);
  assert.deepEqual(pixel(highlighted, 4, 3, 1), [0, 0, 0, 0]);
  assert.deepEqual(pixel(highlighted, 4, 1, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(highlighted, 4, 3, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(highlighted, 4, 3, 0), [255, 0, 255, 166]);
  assert.deepEqual(pixel(highlighted, 4, 0, 3), [255, 0, 255, 166]);
});

test('a fully ignored image reports a finite zero percentage and preserves the current pixels', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory, true);
  const regions = [{ x: 0, y: 0, width: 100, height: 100 }];
  const report = json(directory, [before, after, '--ignore-region', '0,0,100,100', '--output', 'diff.png', '--fail-on-diff']);
  assert.deepEqual(report.comparison.ignoreRegions, regions);
  assert.equal(report.stats.ignoredPixels, 96); assert.equal(report.stats.comparedPixels, 0);
  assert.equal(report.stats.changedPixels, 0); assert.equal(report.stats.unchangedPixels, 0);
  assert.equal(report.stats.changedPercentage, 0); assert.equal(report.stats.diffBounds, null);
  assert.equal(report.status, 'identical');
  assert.deepEqual(await readPixels(report.output.path), await readPixels(after));
});

test('missing-side comparisons preserve added/removed metadata while ignored coverage never fails a run', async t => {
  const directory = await workspace(t); const before = path.join(directory, 'before.png');
  await image(before, 3, 2);
  const ignoreRegions = [{ x: 0, y: 0, width: 3, height: 2 }];
  for (const kind of ['added', 'removed'] as const) {
    const result = await comparePair(kind === 'added' ? null : before, kind === 'removed' ? null : before, {
      output: path.join(directory, `${kind}.png`), ignoreRegions
    });
    assert.equal(result[kind === 'added' ? 'before' : 'after'], null);
    assert.equal(result.ignoredPixels, 6); assert.equal(result.comparedPixels, 0); assert.equal(result.changedPixels, 0);
    assert.equal(result.changedPercentage, 0);
    assert.deepEqual(await readPixels(result.outputPath), kind === 'added' ? await readPixels(before) : pixels(3, 2, [0, 0, 0, 0]));
  }
  await mkdir(path.join(directory, 'baseline')); await mkdir(path.join(directory, 'current'));
  await writeFile(path.join(directory, 'baseline', 'removed.png'), await readFile(before));
  await writeFile(path.join(directory, 'current', 'added.png'), await readFile(before));
  const report = json(directory, ['.', '--ignore-region', '0,0,3,2', '--output-dir', 'report', '--fail-on-diff']);
  assert.deepEqual(report.results.map((entry: { status: string }) => entry.status), ['added', 'removed']);
  assert.equal(report.summary.added, 1); assert.equal(report.summary.removed, 1);
  assert.equal(report.summary.ignoredPixels, 12); assert.equal(report.summary.comparedPixels, 0);
  assert.equal(report.summary.changedPixels, 0); assert.equal(report.summary.changedPercentage, 0);
});

test('repeatable CLI regions suppress a clock and another dynamic area while JSON reports the selected regions', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory, true);
  const report = json(directory, [before, after, '--ignore-region', '0,0,12,2', '--ignore-region', '7,4,2,2', '--fail-on-diff']);
  assert.deepEqual(report.comparison.ignoreRegions, [clock, { x: 7, y: 4, width: 2, height: 2 }]);
  assert.equal(report.stats.ignoredPixels, 28); assert.equal(report.stats.comparedPixels, 68);
  assert.equal(report.stats.changedPixels, 0); assert.equal(report.stats.unchangedPixels, 68);
  assert.deepEqual(await readPixels(report.output.path), await readPixels(after));
  const unignored = json(directory, [before, after, '--output', 'unignored.png', '--fail-on-diff'], 1);
  assert.deepEqual(unignored.comparison.ignoreRegions, []); assert.equal(unignored.stats.ignoredPixels, 0);
  assert.equal(unignored.stats.changedPixels, 8);
});

test('single files, folder modes, and manifests share config rectangles and explicit CLI rectangles replace them', async t => {
  const directory = await workspace(t); const { baseline, current, before, after } = await folderClockPair(directory, true);
  const config = path.join(directory, 'diffglow.config.json');
  await writeFile(config, JSON.stringify({ ignoreRegions: [clock] }));
  const manifest = path.join(directory, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'phone', before: 'baseline/phone.png', after: 'current/phone.png' }] }));
  const cases = [
    { args: [before, after, '--config', config, '--output', 'single.png'], regions: [clock], ignored: 24 },
    { args: ['.', '--html', '--output-dir', 'root-report'], regions: [clock], ignored: 24 },
    { args: [baseline, current, '--config', config, '--ignore-region', '7,4,2,2', '--output-dir', 'folders-report'], regions: [{ x: 7, y: 4, width: 2, height: 2 }], ignored: 4 },
    { args: ['--manifest', manifest, '--config', config, '--html', '--output-dir', 'manifest-report'], regions: [clock], ignored: 24 }
  ];
  for (const entry of cases) {
    const report = json(directory, [...entry.args, '--fail-on-diff'], 1);
    assert.deepEqual(report.comparison.ignoreRegions, entry.regions);
    const comparison = report.mode === 'batch' ? report.results[0] : report;
    assert.deepEqual(comparison.comparison.ignoreRegions, entry.regions);
    assert.equal(comparison.stats.ignoredPixels, entry.ignored);
    assert.equal(comparison.stats.comparedPixels, 96 - entry.ignored);
    assert.equal(comparison.stats.changedPixels, 4);
    if (report.mode === 'batch') assert.equal(report.summary.ignoredPixels, entry.ignored);
    if (report.htmlReportPath) {
      const html = await readFile(report.htmlReportPath, 'utf8');
      assert.match(html, /ignor/i);
      const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(embedded);
      assert.deepEqual(JSON.parse(embedded[1]).comparison.ignoreRegions, entry.regions);
      const persisted = JSON.parse(await readFile(path.join(report.outputDirectory, 'results.json'), 'utf8'));
      assert.deepEqual(persisted.comparison.ignoreRegions, entry.regions);
      assert.equal(persisted.summary.ignoredPixels, entry.ignored);
    }
  }
});

test('invalid typed core regions fail before output or preview directories can be modified', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory);
  const output = path.join(directory, 'preserve.png'); const sentinel = Buffer.from('existing output');
  await writeFile(output, sentinel);
  const invalid: unknown[] = [
    null, {}, '0,0,12,2', [null], [[0, 0, 12, 2]],
    [{ x: 0, y: 0, width: 12 }], [{ x: 0, y: 0, width: 12, height: 2, extra: 1 }],
    [{ x: -1, y: 0, width: 12, height: 2 }], [{ x: 0, y: 0.5, width: 12, height: 2 }],
    [{ x: 0, y: 0, width: 0, height: 2 }], [{ x: 0, y: 0, width: 12, height: -2 }],
    [{ x: 0, y: 0, width: '12', height: 2 }], [{ x: Number.NaN, y: 0, width: 12, height: 2 }],
    [{ x: 0, y: Number.POSITIVE_INFINITY, width: 12, height: 2 }],
    [{ x: Number.MAX_SAFE_INTEGER + 1, y: 0, width: 12, height: 2 }],
    [{ x: Number.MAX_SAFE_INTEGER, y: 0, width: 1, height: 2 }],
    [{ x: 0, y: Number.MAX_SAFE_INTEGER, width: 1, height: 2 }]
  ];
  for (const value of invalid) {
    await assert.rejects(diffScreenshots(before, after, {
      output, ignoreRegions: value as typeof clock[],
      previews: { baseline: path.join(directory, 'previews/baseline.png'), current: path.join(directory, 'previews/current.png') }
    }), regionError);
    assert.deepEqual(await readFile(output), sentinel);
  }
  await assert.rejects(access(path.join(directory, 'previews')), { code: 'ENOENT' });
});

test('malformed CLI rectangles return exit 2 without replacing existing files', async t => {
  const directory = await workspace(t); const { before, after } = await clockPair(directory);
  const output = path.join(directory, 'preserve.png'); const sentinel = Buffer.from('keep this output');
  await writeFile(output, sentinel);
  for (const value of ['', '0,0,12', '0,0,12,2,3', '0,0,12px,2', '0,-1,12,2', '0,0,0,2', '0,0,1.5,2']) {
    const report = json(directory, [before, after, '--output', output, '--ignore-region', value], 2);
    assert.equal(report.status, 'error'); assert.match(report.error.message, regionError);
    assert.deepEqual(await readFile(output), sentinel);
  }
});

test('invalid config remains an error even when valid CLI regions would replace it and existing reports survive', async t => {
  const directory = await workspace(t); await folderClockPair(directory);
  const reportDirectory = path.join(directory, 'report');
  const initial = json(directory, ['.', '--output-dir', reportDirectory, '--html']);
  const originalJSON = await readFile(path.join(reportDirectory, 'results.json'));
  const originalHTML = await readFile(initial.htmlReportPath);
  const originalDiff = await readFile(initial.results[0].output.path);
  const config = path.join(directory, 'invalid.json');
  await writeFile(config, JSON.stringify({ ignoreRegions: [{ x: 0, y: 0, width: 0, height: 2 }] }));
  const report = json(directory, ['.', '--config', config, '--ignore-region', '0,0,12,2', '--output-dir', reportDirectory, '--html'], 2);
  assert.match(report.error.message, regionError);
  assert.deepEqual(await readFile(path.join(reportDirectory, 'results.json')), originalJSON);
  assert.deepEqual(await readFile(initial.htmlReportPath), originalHTML);
  assert.deepEqual(await readFile(initial.results[0].output.path), originalDiff);
  assert.ok((await readdir(directory)).every(name => !/^\.diffglow-(?:stage|backup)-/.test(name)));
});
