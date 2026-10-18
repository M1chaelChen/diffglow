import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, link, mkdir, readFile, realpath, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { globMatcher, templateMatcher } from '../src/discovery.js';
import type { RunReport } from '../src/batch.js';
import { image, pixels, readPixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
function run(cwd: string, args: string[], expected = 0) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], { cwd, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function json(cwd: string, args: string[], expected = 0): RunReport {
  const result = run(cwd, [...args, '--json'], expected);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as RunReport;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.exitCode, expected);
  assert.equal(result.stdout, JSON.stringify(report, null, 2) + '\n');
  return report;
}
async function roots(dir: string) {
  const baseline = path.join(dir, 'baseline'); const current = path.join(dir, 'current');
  await mkdir(baseline); await mkdir(current);
  return { baseline, current };
}
async function screenshot(root: string, name: string, width = 4, height = 4, color = [255, 255, 255, 255]) {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true });
  await image(file, width, height, pixels(width, height, color)); return file;
}

test('folder batch reports all statuses, continues after decoding errors, and weights aggregate pixels', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  for (const root of [baseline, current]) {
    await screenshot(root, 'same.png'); await screenshot(root, 'changed.png', 4, 4, root === current ? [0, 0, 0, 255] : undefined);
    await screenshot(root, 'broken.png');
  }
  await writeFile(path.join(current, 'broken.png'), 'not a screenshot');
  await screenshot(current, 'nested/added.png', 2, 3); await screenshot(baseline, 'nested/removed.png', 3, 2);
  await writeFile(path.join(current, 'ignored.txt'), 'text');
  const report = json(dir, ['.', '--html', '--fail-on-diff'], 2);
  assert.equal(report.mode, 'batch'); assert.equal(report.status, 'error');
  assert.deepEqual(report.results.map(entry => [entry.id, entry.status]), [
    ['broken.png', 'error'], ['changed.png', 'different'], ['nested/added.png', 'added'], ['nested/removed.png', 'removed'], ['same.png', 'identical']
  ]);
  assert.deepEqual(report.summary, {
    total: 5, compared: 4, different: 1, identical: 1, added: 1, removed: 1, errors: 1,
    comparedPixels: 44, changedPixels: 28, unchangedPixels: 16, modifiedPixels: 16, addedPixels: 6, removedPixels: 6, changedPercentage: 28 / 44 * 100
  });
  const disk = JSON.parse(await readFile(path.join(report.outputDirectory, 'results.json'), 'utf8'));
  assert.deepEqual(disk, report);
  const html = await readFile(report.htmlReportPath!, 'utf8');
  assert.match(html, /Baseline vs current/); assert.match(html, /Comparison failed/); assert.match(html, /Not present/);
  // Exercise the generated page's actual filter script without network or filesystem access.
  const listeners = new Map<string, () => void>();
  const search = { value: '', addEventListener: (event: string, callback: () => void) => listeners.set(`search:${event}`, callback) };
  const status = { value: 'all', addEventListener: (event: string, callback: () => void) => listeners.set(`status:${event}`, callback) };
  const showing = { textContent: '' }; const noResults = { hidden: true };
  const cards = report.results.map(entry => ({ dataset: { key: entry.id.toLowerCase(), status: entry.status }, hidden: false }));
  const elements: Record<string, unknown> = { search, status, showing, 'no-results': noResults };
  const document = {
    getElementById: (id: string) => elements[id],
    querySelectorAll: () => cards
  };
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  runInNewContext(script, { document }, { timeout: 1000 });
  status.value = 'changes'; listeners.get('status:change')!();
  assert.deepEqual(cards.filter(card => !card.hidden).map(card => card.dataset.status), ['different', 'added', 'removed']);
  assert.equal(showing.textContent, '3 of 5 comparisons');
  status.value = 'all'; search.value = 'NESTED/ADDED'; listeners.get('search:input')!();
  assert.deepEqual(cards.filter(card => !card.hidden).map(card => card.dataset.key), ['nested/added.png']);
  search.value = 'no matching screenshot'; listeners.get('search:input')!();
  assert.equal(showing.textContent, '0 of 5 comparisons'); assert.equal(noResults.hidden, false);
  search.value = ''; status.value = 'error'; listeners.get('status:change')!();
  assert.equal(showing.textContent, '1 of 5 comparisons'); assert.equal(noResults.hidden, true);
  for (const entry of report.results) {
    if (entry.status === 'error') { assert.equal(entry.artifacts, null); assert.match(entry.error.message, /Cannot decode/); continue; }
    assert.equal((await stat(entry.output.path)).isFile(), true);
    const output = await readPixels(entry.output.path);
    if (entry.status === 'added' || entry.status === 'removed') {
      assert.deepEqual(entry.stats.diffBounds, { x: 0, y: 0, width: entry.output.width, height: entry.output.height });
      assert.equal(entry.stats.changedPercentage, 100); assert.equal(entry.stats.modifiedPixels, 0);
      assert.deepEqual([...output.subarray(0, 4)], [255, 89, 255, 255]);
      assert.equal(entry.status === 'added' ? entry.before : entry.after, null);
    }
    for (const asset of Object.values(entry.artifacts)) if (asset) {
      assert.ok(!path.isAbsolute(asset) && !asset.includes('..')); await access(path.join(report.outputDirectory, asset));
    }
  }
});

test('batch output is deterministic, reusable, and removes stale HTML and screenshot assets', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  const file = await screenshot(current, 'first.png', 2, 3);
  const first = json(dir, [baseline, current, '--html', '--threshold', '1']);
  assert.equal(first.status, 'different'); assert.equal(first.exitCode, 0);
  const rerun = json(dir, [baseline, current, '--html', '--threshold', '1']); assert.deepEqual(rerun, first);
  const oldAssets = first.results[0].artifacts!;
  await rm(file); await screenshot(current, 'second.png');
  const next = json(dir, [baseline, current, '--threshold', '1', '--fail-on-diff'], 1);
  assert.deepEqual(next.results.map(entry => entry.id), ['second.png']);
  assert.equal(next.htmlReportPath, null);
  await assert.rejects(access(path.join(next.outputDirectory, 'index.html')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(next.outputDirectory, oldAssets.diff)), { code: 'ENOENT' });
});

test('identical folder batches succeed with fail-on-diff and preserve pixels', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  const before = await screenshot(baseline, 'nested/Screen.PNG'); await screenshot(current, 'nested/Screen.PNG');
  const report = json(dir, ['.', '--fail-on-diff']);
  assert.equal(report.summary.identical, 1); assert.equal(report.summary.changedPercentage, 0);
  const entry = report.results[0]; assert.notEqual(entry.status, 'error');
  if (entry.status === 'error') return;
  assert.equal(entry.stats.diffBounds, null); assert.deepEqual(await readPixels(entry.output.path), await readPixels(before));
});

test('config supports custom roots, recursive globs, exclusions, and CLI threshold precedence', async t => {
  const dir = await realpath(await workspace(t));
  for (const name of ['approved', 'latest']) {
    await screenshot(path.join(dir, name), 'nested/home.png', 4, 4, name === 'latest' ? [102, 102, 102, 255] : [100, 100, 100, 255]);
    await screenshot(path.join(dir, name), 'nested/skip1.png'); await screenshot(path.join(dir, name), 'not-included.png');
  }
  await writeFile(path.join(dir, 'diffglow.config.json'), JSON.stringify({ baselineDir: 'approved', currentDir: 'latest', include: ['nested/**/*.png'], exclude: ['**/skip?.png'], threshold: 1 }));
  const tolerant = json(dir, ['.']); assert.equal(tolerant.results.length, 1); assert.equal(tolerant.summary.changedPixels, 0);
  const strict = json(dir, ['.', '--threshold', '0', '--fail-on-diff'], 1);
  assert.equal(strict.summary.changedPixels, 16); assert.equal(strict.comparison.threshold, 0);
});

test('one-folder naming templates pair nested PNG and JPEG inputs across extensions', async t => {
  const dir = await realpath(await workspace(t));
  const original = await screenshot(dir, 'home.baseline.png');
  await sharp(original).jpeg().toFile(path.join(dir, 'home.current.jpg'));
  const second = await screenshot(dir, 'nested/设置.baseline.PNG');
  await sharp(second).jpeg().toFile(path.join(dir, 'nested/设置.current.JPEG'));
  await screenshot(dir, 'unmatched.png');
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ baselineDir: '.', currentDir: '.', baselinePattern: '{key}.baseline.{ext}', currentPattern: '{key}.current.{ext}' }));
  const args = ['.', '--config', config, '--html'];
  const report = json(dir, args);
  assert.deepEqual(report.results.map(entry => entry.id), ['home', 'nested/设置']); assert.equal(report.summary.identical, 2);
  // Even matching names inside the generated report must never enter the next batch.
  await screenshot(report.outputDirectory, 'extra.baseline.png');
  await screenshot(report.outputDirectory, 'extra.current.png');
  assert.deepEqual(json(dir, args), report);
});

test('manifest paths resolve relative to the manifest, IDs are safely rendered, and reports survive source removal', async t => {
  const dir = await realpath(await workspace(t)); const source = path.join(dir, 'sources'); await mkdir(source);
  const before = await screenshot(source, 'before image.png'); const after = await screenshot(source, 'after image.png', 4, 4, [0, 0, 0, 255]);
  const manifest = path.join(source, 'pairs.json');
  const id = '../../<script>window.DIFFGLOW_XSS=1</script> & "设置"';
  await writeFile(manifest, JSON.stringify({ pairs: [{ id, before: 'before image.png', after: 'after image.png' }] }));
  const report = json(dir, ['--manifest', manifest, '--html']);
  assert.equal(report.results[0].id, id); assert.equal(report.summary.changedPixels, 16);
  const html = await readFile(report.htmlReportPath!, 'utf8');
  assert.ok(!html.includes('<script>window.DIFFGLOW_XSS=1</script>'));
  assert.match(html, /&lt;script&gt;/); assert.match(html, /\\u003cscript/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["'](?:https?:|\/\/)/i);
  const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.deepEqual(JSON.parse(embedded![1]), report);
  await rm(source, { recursive: true });
  for (const match of html.matchAll(/<img src="([^"]+)"/g)) await access(path.join(report.outputDirectory, match[1]));
  assert.equal((await readdir(path.join(report.outputDirectory, 'assets'))).length, 1);
});

test('explicit manifest missing paths remain errors rather than added/removed screenshots', async t => {
  const dir = await realpath(await workspace(t)); const before = await screenshot(dir, 'before.png');
  const manifest = path.join(dir, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [
    { id: 'a-missing', before: 'missing.png', after: path.basename(before) },
    { id: 'z-valid', before: path.basename(before), after: path.basename(before) }
  ] }));
  const report = json(dir, ['--manifest', manifest, '--fail-on-diff'], 2);
  assert.equal(report.summary.errors, 1); assert.equal(report.summary.identical, 1); assert.equal(report.summary.added, 0);
  assert.equal(report.results[1].status, 'identical');
});

test('single-pair HTML preserves the existing JSON shape and supports a PNG inside its report directory', async t => {
  const dir = await realpath(await workspace(t)); const before = await screenshot(dir, 'before.png');
  const after = await screenshot(dir, 'after.png', 4, 4, [0, 0, 0, 255]);
  const output = path.join(dir, 'highlighted.png');
  const args = [before, after, '--output', output, '--json', '--fail-on-diff'];
  const plain = JSON.parse(run(dir, args, 1).stdout);
  const html = JSON.parse(run(dir, [...args, '--html'], 1).stdout);
  assert.deepEqual(html, plain);
  const nested = path.join(dir, 'diffglow-report', 'custom', 'highlighted.png');
  const payload = JSON.parse(run(dir, [before, after, '--html', '--json', '-o', nested], 0).stdout);
  assert.equal(payload.output.path, nested); await access(nested);
  const saved = JSON.parse(await readFile(path.join(dir, 'diffglow-report', 'results.json'), 'utf8')) as RunReport;
  assert.equal(saved.mode, 'single'); assert.equal(saved.results.length, 1);
  assert.deepEqual(await readPixels(nested), await readPixels(output));
});

test('single-pair HTML can present a failed comparison without changing the JSON error contract', async t => {
  const dir = await realpath(await workspace(t)); const good = await screenshot(dir, 'good.png');
  const bad = path.join(dir, 'bad.png'); await writeFile(bad, 'bad image');
  const result = run(dir, [good, bad, '--html', '--json'], 2);
  assert.equal(result.stderr, ''); const error = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(error).sort(), ['error', 'exitCode', 'schemaVersion', 'status']);
  assert.match(await readFile(path.join(dir, 'diffglow-report', 'index.html'), 'utf8'), /Comparison failed/);
});

test('HTML previews use the normalized compared orientation and pixel buffers', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  const before = await screenshot(baseline, 'oriented.jpg', 2, 3, [60, 90, 120, 255]);
  const after = path.join(current, 'oriented.jpg');
  await sharp(before).withMetadata({ orientation: 6 }).jpeg({ quality: 100 }).toFile(after);
  const report = json(dir, ['.', '--html']); const entry = report.results[0];
  if (entry.status === 'error') throw new Error(entry.error.message);
  assert.deepEqual([entry.after!.width, entry.after!.height], [3, 2]);
  const preview = path.join(report.outputDirectory, entry.artifacts.current!);
  const normalized = await sharp(after).autoOrient().toColourspace('srgb').ensureAlpha().raw().toBuffer();
  assert.deepEqual(await readPixels(preview), normalized);
});

test('invalid configuration, ambiguous pairs, empty batches, and invalid input mode combinations fail before output', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  const before = await screenshot(baseline, 'one.baseline.png'); await screenshot(current, 'one.current.png');
  const output = path.join(dir, 'never-written'); const config = path.join(dir, 'config.json');
  const cases = [
    { config: { unknown: true }, args: ['.'], message: /Unknown configuration/ },
    { config: { include: [] }, args: ['.'], message: /include/ },
    { config: { include: ['**/*.{png,jpg}'] }, args: ['.'], message: /Globs/ },
    { config: { exclude: ['foo**bar'] }, args: ['.'], message: /complete path segment/ },
    { config: { baselinePattern: '{wrong}' }, args: ['.'], message: /templates/ },
    { config: { baselinePattern: '{key}{key}' }, args: ['.'], message: /templates/ },
    { config: { threshold: 2 }, args: ['.'], message: /Threshold/ },
    { config: {}, args: [baseline, before], message: /do not mix/ },
    { config: {}, args: ['.', '--output', 'wrong.png'], message: /--output-dir/ }
  ];
  for (const entry of cases) {
    await writeFile(config, JSON.stringify(entry.config));
    const result = run(dir, [...entry.args, '--config', config, '--output-dir', output, '--json'], 2);
    assert.match(JSON.parse(result.stdout).error.message, entry.message); await assert.rejects(access(output), { code: 'ENOENT' });
  }
  await writeFile(config, '{invalid json');
  assert.match(JSON.parse(run(dir, ['.', '--config', config, '--json'], 2).stdout).error.message, /Cannot read JSON/);
  await writeFile(config, JSON.stringify({ baselinePattern: '{key}.baseline.{ext}', currentPattern: '{key}.current.{ext}' }));
  await copyFile(before, path.join(baseline, 'one.baseline.jpg'));
  assert.match(JSON.parse(run(dir, ['.', '--config', config, '--json'], 2).stdout).error.message, /Ambiguous/);
  const manifest = path.join(dir, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'same', before, after: before }, { id: 'same', before, after: before }] }));
  assert.match(JSON.parse(run(dir, ['--manifest', manifest, '--json'], 2).stdout).error.message, /Duplicate/);
  assert.match(JSON.parse(run(dir, ['.', '--manifest', manifest, '--json'], 2).stdout).error.message, /cannot be combined/);
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'null', before: null, after: before }] }));
  assert.match(JSON.parse(run(dir, ['--manifest', manifest, '--json'], 2).stdout).error.message, /requires/);
  const emptyBaseline = path.join(dir, 'empty baseline'); const emptyCurrent = path.join(dir, 'empty current');
  await mkdir(emptyBaseline); await mkdir(emptyCurrent);
  assert.match(JSON.parse(run(dir, [emptyBaseline, emptyCurrent, '--json'], 2).stdout).error.message, /No PNG\/JPEG/);
});

test('report output cannot replace unrelated directories, input roots, or manifest input files', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  const before = await screenshot(baseline, 'home.png'); await screenshot(current, 'home.png');
  const protectedBytes = await readFile(before);
  const output = path.join(dir, 'unrelated'); await mkdir(output); await writeFile(path.join(output, 'notes.txt'), 'keep me');
  const rejected = json(dir, ['.', '--output-dir', output], 2);
  assert.match((rejected as unknown as { error: { message: string } }).error.message, /not empty or Diffglow-owned/);
  assert.equal(await readFile(path.join(output, 'notes.txt'), 'utf8'), 'keep me');
  for (const target of [baseline, dir]) run(dir, ['.', '--output-dir', target, '--json'], 2);
  const manifest = path.join(dir, 'pairs.json'); await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'one', before, after: before }] }));
  await writeFile(path.join(baseline, '.diffglow-report'), '{"tool":"diffglow","schemaVersion":1}\n');
  const result = run(dir, ['--manifest', manifest, '--output-dir', baseline, '--json'], 2);
  assert.match(JSON.parse(result.stdout).error.message, /must not equal or contain an input/);
  const hard = path.join(dir, 'alias.png'); await link(before, hard);
  assert.match(JSON.parse(run(dir, [before, before, '--html', '--json', '-o', hard], 2).stdout).error.message, /must not overwrite/);
  assert.deepEqual(await readFile(before), protectedBytes);
});

test('directory traversal skips symlink loops and rejects linked report output', async t => {
  const dir = await realpath(await workspace(t)); const { baseline, current } = await roots(dir);
  await screenshot(baseline, 'home.png'); await screenshot(current, 'home.png');
  try { await symlink(baseline, path.join(baseline, 'loop'), 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('Windows symlink privileges unavailable.'); return; }
    throw error;
  }
  const report = json(dir, ['.']); assert.equal(report.results.length, 1);
  const alias = path.join(dir, 'linked-report'); await symlink(report.outputDirectory, alias, 'dir');
  assert.match(JSON.parse(run(dir, ['.', '--output-dir', alias, '--json'], 2).stdout).error.message, /symbolic link/);
});

test('glob and template matching use portable, explicit syntax', () => {
  for (const value of ['home.png', 'a/home.png', 'a/b/home.png']) assert.ok(globMatcher('**/*.png').test(value));
  assert.ok(!globMatcher('*.png').test('a/home.png')); assert.ok(globMatcher('a/?.png').test('a/中.png'));
  assert.ok(!globMatcher('a/?.png').test('a/long.png'));
  assert.equal(templateMatcher('{key}.baseline.{ext}').exec('nested/home.baseline.JPEG')?.groups?.key, 'nested/home');
  assert.equal(templateMatcher('{key}').exec('nested/home.png')?.groups?.key, 'nested/home.png');
});
