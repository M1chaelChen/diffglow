import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { comparePair, diffScreenshots } from '../src/diff.js';
import { image, pixel, pixels, readPixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const colorError = /highlight[ -]?color/i;

function run(cwd: string, args: string[], expected = 0) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], { cwd, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function json(cwd: string, args: string[], expected = 0) {
  const result = run(cwd, [...args, '--json'], expected);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.exitCode, expected);
  return report;
}
async function changedPair(directory: string) {
  const before = path.join(directory, 'before.png'); const after = path.join(directory, 'after.png');
  const candidate = pixels(8, 6);
  for (let y = 2; y < 4; y++) for (let x = 3; x < 5; x++) candidate.set([0, 100, 200, 255], (y * 8 + x) * 4);
  await image(before, 8, 6); await image(after, 8, 6, candidate);
  return { before, after };
}
async function folderPair(directory: string) {
  const baseline = path.join(directory, 'baseline'); const current = path.join(directory, 'current');
  await mkdir(baseline); await mkdir(current);
  const before = path.join(baseline, 'home.png'); const after = path.join(current, 'home.png');
  await image(before, 4, 4); await image(after, 4, 4, pixels(4, 4, [0, 0, 0, 255]));
  return { baseline, current, before, after };
}
async function directorySnapshot(directory: string): Promise<Record<string, string | number>> {
  const snapshot: Record<string, string | number> = {};
  async function walk(current: string) {
    snapshot[`${path.relative(directory, current)}/mtime`] = (await stat(current)).mtimeMs;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else snapshot[path.relative(directory, filename)] = (await readFile(filename)).toString('hex');
    }
  }
  await walk(directory);
  return snapshot;
}

test('custom green highlights blend only changed opaque pixels while the default stays magenta', async t => {
  const directory = await workspace(t); const { before, after } = await changedPair(directory);
  const output = path.join(directory, 'green.png');
  const result = await diffScreenshots(before, after, { output, highlightColor: '#0F0' });
  assert.equal(result.highlightColor, '#00ff00');
  assert.equal(result.changedPixels, 4);
  assert.deepEqual(result.diffBounds, { x: 3, y: 2, width: 2, height: 2 });
  const highlighted = await readPixels(output); const original = await readPixels(after);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
    assert.deepEqual(pixel(highlighted, 8, x, y), x >= 3 && x < 5 && y >= 2 && y < 4 ? [0, 201, 70, 255] : pixel(original, 8, x, y));
  }
  const defaultResult = await diffScreenshots(before, after, { output: path.join(directory, 'default.png') });
  assert.equal(defaultResult.highlightColor, '#ff00ff');
  assert.deepEqual(pixel(await readPixels(defaultResult.outputPath), 8, 3, 2), [166, 35, 236, 255]);
});

test('hex color normalization is case insensitive and does not alter the comparison mask or statistics', async t => {
  const directory = await workspace(t); const { before, after } = await changedPair(directory);
  const colors = [['#000', '#000000', [0, 35, 70, 255]], ['#00F', '#0000ff', [0, 35, 236, 255]], ['#00fF00', '#00ff00', [0, 201, 70, 255]]] as const;
  for (const [value, canonical, changedPixel] of colors) {
    const result = await diffScreenshots(before, after, { output: path.join(directory, `${canonical.slice(1)}.png`), highlightColor: value });
    assert.equal(result.highlightColor, canonical);
    assert.deepEqual({
      changed: result.changedPixels, unchanged: result.unchangedPixels, modified: result.modifiedPixels,
      added: result.addedPixels, removed: result.removedPixels, compared: result.comparedPixels,
      percentage: result.changedPercentage, bounds: result.diffBounds
    }, { changed: 4, unchanged: 44, modified: 4, added: 0, removed: 0, compared: 48, percentage: 4 / 48 * 100, bounds: { x: 3, y: 2, width: 2, height: 2 } });
    assert.deepEqual(pixel(await readPixels(result.outputPath), 8, 3, 2), changedPixel);
  }
});

test('custom highlights preserve alpha compositing on partially and fully transparent current images', async t => {
  const directory = await workspace(t); const before = path.join(directory, 'before.png');
  await image(before, 4, 4, pixels(4, 4, [0, 0, 0, 255]));
  for (const [name, current, expected] of [
    ['partial', [200, 40, 80, 128], [43, 209, 17, 211]],
    ['transparent', [0, 0, 0, 0], [0, 255, 0, 166]]
  ] as const) {
    const after = path.join(directory, `${name}.png`);
    await image(after, 4, 4, pixels(4, 4, [...current]));
    const result = await diffScreenshots(before, after, { output: path.join(directory, `${name}-diff.png`), highlightColor: '#00ff00' });
    assert.equal(result.changedPixels, 16);
    assert.deepEqual(pixel(await readPixels(result.outputPath), 4, 1, 1), expected);
  }
});

for (const kind of ['added', 'removed'] as const) {
  test(`${kind} dimension areas use the selected color and still count transparent image coverage`, async t => {
    const directory = await workspace(t); const before = path.join(directory, 'before.png'); const after = path.join(directory, 'after.png');
    await image(before, kind === 'added' ? 2 : 4, 3, pixels(kind === 'added' ? 2 : 4, 3, [0, 0, 0, 0]));
    await image(after, kind === 'added' ? 4 : 2, 3, pixels(kind === 'added' ? 4 : 2, 3, [0, 0, 0, 0]));
    const result = await diffScreenshots(before, after, { output: path.join(directory, 'diff.png'), threshold: 1, highlightColor: '#0f0' });
    assert.equal(result.changedPixels, 6); assert.equal(result[kind === 'added' ? 'addedPixels' : 'removedPixels'], 6);
    assert.deepEqual(result.diffBounds, { x: 2, y: 0, width: 2, height: 3 });
    const highlighted = await readPixels(result.outputPath);
    assert.deepEqual(pixel(highlighted, 4, 0, 1), [0, 0, 0, 0]);
    assert.deepEqual(pixel(highlighted, 4, 3, 1), [0, 255, 0, 166]);
    const whole = await comparePair(kind === 'added' ? null : before, kind === 'added' ? after : null, {
      output: path.join(directory, 'whole-diff.png'), highlightColor: '#0f0'
    });
    assert.equal(whole.changedPercentage, 100); assert.equal(whole.changedPixels, 12);
    assert.deepEqual(pixel(await readPixels(whole.outputPath), 4, 0, 0), [0, 255, 0, 166]);
  });
}

test('CLI single-pair JSON describes the selected rendering and keeps the default when omitted', async t => {
  const directory = await workspace(t); const { before, after } = await changedPair(directory);
  const standard = json(directory, [before, after, '--output', 'standard.png']);
  assert.deepEqual(standard.rendering, { highlightColor: '#ff00ff', highlightOpacity: 0.65 });
  const custom = json(directory, [before, after, '--output', 'custom.png', '--highlight-color', '#0F0', '--fail-on-diff'], 1);
  assert.deepEqual(custom.rendering, { highlightColor: '#00ff00', highlightOpacity: 0.65 });
  assert.deepEqual(custom.stats, standard.stats);
  assert.deepEqual(pixel(await readPixels(custom.output.path), 8, 3, 2), [0, 201, 70, 255]);
});

test('root, two-folder, single-pair, and manifest modes honor CLI over config over the default color', async t => {
  const directory = await workspace(t); const { baseline, current, before, after } = await folderPair(directory);
  const config = path.join(directory, 'diffglow.config.json'); await writeFile(config, JSON.stringify({ highlightColor: '#F80' }));
  const manifest = path.join(directory, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'home', before: 'baseline/home.png', after: 'current/home.png' }] }));
  const cases = [
    { args: ['.', '--html', '--output-dir', 'root-report'], color: '#ff8800', expected: [166, 88, 0, 255] },
    { args: [baseline, current, '--config', config, '--highlight-color', '#0F0', '--output-dir', 'folders-report'], color: '#00ff00', expected: [0, 166, 0, 255] },
    { args: [before, after, '--config', config, '--output', 'single.png'], color: '#ff8800', expected: [166, 88, 0, 255] },
    { args: ['--manifest', manifest, '--config', config, '--highlight-color', '#00F', '--html', '--output-dir', 'manifest-report'], color: '#0000ff', expected: [0, 0, 166, 255] }
  ];
  for (const entry of cases) {
    const report = json(directory, entry.args);
    assert.deepEqual(report.rendering, { highlightColor: entry.color, highlightOpacity: 0.65 });
    const comparison = report.mode === 'batch' ? report.results[0] : report;
    assert.equal(comparison.stats.changedPixels, 16);
    assert.deepEqual(pixel(await readPixels(comparison.output.path), 4, 1, 1), entry.expected);
    if (report.htmlReportPath) {
      const html = await readFile(report.htmlReportPath, 'utf8');
      assert.ok(html.includes(entry.color));
      assert.doesNotMatch(html, /Magenta marks differences|Magenta overlay/i);
      const footer = /<footer[^>]*>([\s\S]*?)<\/footer>/.exec(html);
      assert.ok(footer); assert.ok(footer[1].includes(entry.color)); assert.match(footer[1], /65%/);
      const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
      assert.ok(embedded);
      assert.deepEqual(JSON.parse(embedded[1]).rendering, report.rendering);
      assert.deepEqual(JSON.parse(await readFile(path.join(report.outputDirectory, 'results.json'), 'utf8')).rendering, report.rendering);
    }
  }
});

test('invalid CLI colors return clear errors before creating or replacing single-pair output', async t => {
  const directory = await workspace(t); const { before, after } = await changedPair(directory);
  const output = path.join(directory, 'preserve.png'); const sentinel = Buffer.from('existing output must survive');
  await writeFile(output, sentinel);
  const invalid = ['', 'red', '00ff00', '#12', '#1234', '#12345678', '#ggg', ' #0f0 ', 'rgb(0,255,0)', '#0f0;display:none', '#0f0"><script>bad()</script>'];
  for (const value of invalid) {
    const report = json(directory, [before, after, '--output', output, '--highlight-color', value], 2);
    assert.equal(report.status, 'error'); assert.match(report.error.message, colorError);
    assert.deepEqual(await readFile(output), sentinel);
  }
  const plain = run(directory, [before, after, '--output', 'absent/diff.png', '--highlight-color', 'green'], 2);
  assert.equal(plain.stdout, ''); assert.match(plain.stderr, colorError);
  await assert.rejects(access(path.join(directory, 'absent')), { code: 'ENOENT' });
});

test('invalid configured or CLI colors leave an existing batch report and its assets untouched', async t => {
  const directory = await workspace(t); await folderPair(directory);
  const reportDirectory = path.join(directory, 'report');
  json(directory, ['.', '--output-dir', reportDirectory, '--html']);
  const snapshot = await directorySnapshot(reportDirectory);
  const parentEntries = await readdir(directory);
  const invalidCLI = json(directory, ['.', '--output-dir', reportDirectory, '--html', '--highlight-color', '#xyz'], 2);
  assert.match(invalidCLI.error.message, colorError);
  assert.deepEqual(await directorySnapshot(reportDirectory), snapshot);
  assert.deepEqual(await readdir(directory), parentEntries);
  const config = path.join(directory, 'invalid-config.json');
  for (const value of ['red', 123, null, false, []]) {
    await writeFile(config, JSON.stringify({ highlightColor: value }));
    const report = json(directory, ['.', '--config', config, '--output-dir', reportDirectory, '--html'], 2);
    assert.match(report.error.message, colorError);
    assert.deepEqual(await directorySnapshot(reportDirectory), snapshot);
  }
  const noOutput = path.join(directory, 'must-not-exist');
  json(directory, ['.', '--output-dir', noOutput, '--highlight-color', '#12345', '--html'], 2);
  await assert.rejects(access(noOutput), { code: 'ENOENT' });
  assert.ok((await readdir(directory)).every(name => !/^\.diffglow-(stage|backup)-/.test(name)));
});

test('invalid core highlight colors fail before writing output or normalizing preview assets', async t => {
  const directory = await workspace(t); const { before, after } = await changedPair(directory);
  const output = path.join(directory, 'untouched.png'); const sentinel = Buffer.from('preserve this existing output');
  await writeFile(output, sentinel);
  await assert.rejects(diffScreenshots(before, after, {
    output, highlightColor: '#12345678', previews: { baseline: path.join(directory, 'previews/baseline.png'), current: path.join(directory, 'previews/current.png') }
  }), colorError);
  assert.deepEqual(await readFile(output), sentinel);
  await assert.rejects(access(path.join(directory, 'previews')), { code: 'ENOENT' });
});
