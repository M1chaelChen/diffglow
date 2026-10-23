import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { RunReport } from '../src/batch.js';
import type { comparisonReport, errorReport } from '../src/report.js';
import { image, pixels, readPixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const privateName = 'PRIVATE_REPORT_OWNER_8675309';

function run(cwd: string, args: string[], expected = 0) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd, encoding: 'utf8', timeout: 20_000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}
function json<T = RunReport>(cwd: string, args: string[], expected = 0): T {
  const result = run(cwd, [...args, '--json'], expected);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout) as T;
  assert.equal(result.stdout, JSON.stringify(report, null, 2) + '\n');
  return report;
}
function privatePathsAbsent(text: string, privateRoot: string, context = 'report') {
  assert.ok(!text.includes(privateRoot), `Report must not contain the absolute private source root: ${context}`);
  assert.ok(!text.includes(privateName), `Report must not contain the source owner directory name: ${context}`);
}
async function fixture(t: Parameters<typeof workspace>[0]) {
  const directory = await realpath(await workspace(t));
  const cwd = path.join(directory, 'consumer');
  const sources = path.join(directory, privateName, 'screenshots with spaces');
  await mkdir(cwd); await mkdir(sources, { recursive: true });
  return { directory, cwd, sources };
}
async function screenshot(root: string, name: string, width = 12, height = 8, color = [255, 255, 255, 255]) {
  const filename = path.join(root, name);
  await mkdir(path.dirname(filename), { recursive: true });
  await image(filename, width, height, pixels(width, height, color));
  return filename;
}
function portableReference(value: string) {
  assert.ok(!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value), `Expected a portable reference, got ${value}`);
  assert.ok(!value.split(/[\\/]/).includes('..'), `Reference must not expose parent paths: ${value}`);
  assert.ok(!value.includes('\\'), 'Portable references use forward slashes.');
}

test('--relative HTML and JSON omit private source paths for successes, missing sides, and decode failures', async t => {
  const { directory, cwd, sources } = await fixture(t);
  const baseline = path.join(sources, 'baseline'); const current = path.join(sources, 'current');
  for (const root of [baseline, current]) {
    await screenshot(root, 'same.png'); await screenshot(root, 'changed.png', 12, 8, root === current ? [0, 0, 0, 255] : undefined);
    await screenshot(root, 'broken.png');
  }
  await writeFile(path.join(current, 'broken.png'), 'not a screenshot');
  await screenshot(current, 'nested/added.png'); await screenshot(baseline, 'nested/removed.png');
  const output = path.join(cwd, 'share report');
  const report = json(cwd, [baseline, current, '--relative', '--html', '--output-dir', output], 2);
  assert.equal(report.outputDirectory, '.'); assert.equal(report.htmlReportPath, 'index.html');
  assert.equal(report.summary.errors, 1); assert.equal(report.summary.compared, 4);
  const rawJSON = await readFile(path.join(output, 'results.json'), 'utf8');
  const html = await readFile(path.join(output, 'index.html'), 'utf8');
  for (const text of [JSON.stringify(report), rawJSON, html]) privatePathsAbsent(text, sources);
  assert.deepEqual(JSON.parse(rawJSON), report);
  const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.deepEqual(JSON.parse(embedded![1]), report);
  for (const entry of report.results) {
    if (entry.status === 'error') {
      assert.match(entry.error.message, /Cannot decode/);
      for (const source of Object.values(entry.inputs)) if (source) portableReference(source);
      continue;
    }
    assert.equal(entry.output.path, entry.artifacts.diff);
    if (entry.before) assert.equal(entry.before.path, entry.artifacts.baseline);
    if (entry.after) assert.equal(entry.after.path, entry.artifacts.current);
    if (entry.status === 'added') assert.equal(entry.before, null);
    if (entry.status === 'removed') assert.equal(entry.after, null);
    for (const source of Object.values(entry.artifacts)) if (source) {
      portableReference(source); await access(path.join(output, source));
    }
  }
  const copy = path.join(directory, 'copied report');
  await cp(output, copy, { recursive: true }); await rm(sources, { recursive: true }); await rm(output, { recursive: true });
  for (const match of html.matchAll(/<img src="([^"]+)"/g)) await access(path.join(copy, match[1]));
  await access(path.join(copy, 'results.json'));
});

test('--relative manifest errors outside cwd and non-HTML input references remain portable', async t => {
  const { cwd, sources } = await fixture(t);
  const before = await screenshot(sources, 'before image.png');
  const after = await screenshot(sources, 'after image.png', 12, 8, [0, 0, 0, 255]);
  const manifest = path.join(sources, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [
    { id: 'missing', before: path.join(sources, 'not found.png'), after },
    { id: 'valid', before, after }
  ] }));
  const output = path.join(cwd, 'json report');
  const report = json(cwd, ['--manifest', manifest, '--relative', '--output-dir', output], 2);
  assert.equal(report.outputDirectory, '.'); assert.equal(report.htmlReportPath, null);
  privatePathsAbsent(JSON.stringify(report), sources);
  privatePathsAbsent(await readFile(path.join(output, 'results.json'), 'utf8'), sources);
  const missing = report.results.find(entry => entry.id === 'missing')!;
  assert.equal(missing.status, 'error');
  if (missing.status === 'error') {
    assert.match(missing.error.message, /Cannot read input/);
    for (const source of Object.values(missing.inputs)) if (source) portableReference(source);
  }
  const valid = report.results.find(entry => entry.id === 'valid')!;
  assert.notEqual(valid.status, 'error');
  if (valid.status !== 'error') {
    assert.equal(valid.before!.path, 'baseline/before image.png');
    assert.equal(valid.after!.path, 'current/after image.png');
    assert.equal(valid.output.path, valid.artifacts.diff); await access(path.join(output, valid.output.path));
  }
});

test('--relative single-pair JSON shortens external paths and preserves the default absolute contract', async t => {
  const { cwd, sources } = await fixture(t);
  const before = await screenshot(sources, 'before image.png');
  const after = await screenshot(sources, 'after image.png', 12, 8, [0, 0, 0, 255]);
  const output = path.join(cwd, 'outputs', 'full diff.png');
  const args = [before, after, '--output', output, '--fail-on-diff'];
  const absolute = json<ReturnType<typeof comparisonReport>>(cwd, args, 1);
  const relative = json<ReturnType<typeof comparisonReport>>(cwd, [...args, '--relative'], 1);
  assert.ok(path.isAbsolute(absolute.before!.path)); assert.ok(path.isAbsolute(absolute.after!.path));
  assert.ok(path.isAbsolute(absolute.output.path));
  assert.deepEqual(relative.stats, absolute.stats); assert.equal(relative.exitCode, 1);
  assert.equal(relative.before!.path, 'before image.png'); assert.equal(relative.after!.path, 'after image.png');
  assert.equal(relative.output.path, 'outputs/full diff.png');
  privatePathsAbsent(JSON.stringify(relative), sources); await access(output);
});

test('--relative text output points to the actual report directory and full-size standalone PNG', async t => {
  const { cwd, sources } = await fixture(t);
  const baseline = path.join(sources, 'baseline'); const current = path.join(sources, 'current');
  const before = await screenshot(baseline, 'screen.png');
  const after = await screenshot(current, 'screen.png', 12, 8, [0, 0, 0, 255]);
  const batch = run(cwd, [baseline, current, '--relative', '--html', '--output-dir', 'share report']);
  assert.equal(batch.stderr, ''); privatePathsAbsent(batch.stdout, sources);
  assert.match(batch.stdout, /^JSON results: share report\/results\.json$/m);
  assert.match(batch.stdout, /^HTML report: share report\/index\.html$/m);
  await access(path.join(cwd, 'share report', 'results.json'));
  await access(path.join(cwd, 'share report', 'index.html'));
  const output = path.join('standalone outputs', 'full diff.png');
  const single = run(cwd, [before, after, '--relative', '--html', '--output-dir', 'compact share report',
    '--output', output, '--max-height', '4', '--image-format', 'webp']);
  assert.equal(single.stderr, ''); privatePathsAbsent(single.stdout, sources);
  assert.match(single.stdout, /^Highlighted image: standalone outputs\/full diff\.png$/m);
  assert.match(single.stdout, /^HTML report: compact share report\/index\.html$/m);
  assert.doesNotMatch(single.stdout, /assets\//);
  const metadata = await sharp(path.join(cwd, output)).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 12, 8]);
});

test('--relative sanitizes invalid options and input, JSON, folder, and output errors before report generation', async t => {
  const { cwd, sources } = await fixture(t);
  const before = await screenshot(sources, 'before.png'); const after = await screenshot(sources, 'after.png');
  const bad = path.join(sources, 'bad.png'); await writeFile(bad, 'not a screenshot');
  const malformed = path.join(sources, 'bad config.json'); await writeFile(malformed, '{');
  const outputDirectory = path.join(sources, 'output.png'); await mkdir(outputDirectory);
  const cases = [
    { args: [`--unsupported=${path.join(sources, 'unknown.png')}`], message: /Unknown option/ },
    { args: [path.join(sources, 'not found.png'), after], message: /Cannot read input/ },
    { args: [bad, after], message: /Cannot decode/ },
    { args: [before, after, '--config', path.join(sources, 'missing config.json')], message: /Cannot read JSON/ },
    { args: [before, after, '--config', malformed], message: /Cannot read JSON/ },
    { args: [path.join(sources, 'missing folder')], message: /Cannot read screenshot folder/ },
    { args: [before, after, '--output', outputDirectory], message: /Cannot write output/ }
  ];
  for (const { args, message } of cases) {
    const result = run(cwd, [...args, '--relative', '--json'], 2);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout) as ReturnType<typeof errorReport>;
    privatePathsAbsent(result.stdout, sources, `Error case ${message.source}: ${report.error.message}`);
    assert.equal(report.status, 'error'); assert.equal(report.exitCode, 2); assert.match(report.error.message, message);
  }
  const text = run(cwd, [bad, after, '--relative'], 2);
  privatePathsAbsent(text.stderr, sources); assert.match(text.stderr, /Cannot decode/);
});

function noise(width: number, height: number): Buffer {
  const data = pixels(width, height);
  let state = 0x12345678;
  for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    data[i + channel] = state & 255;
  }
  return data;
}
async function assetBytes(directory: string, report: RunReport): Promise<number> {
  let bytes = 0;
  for (const entry of report.results) if (entry.status !== 'error') {
    for (const filename of Object.values(entry.artifacts)) if (filename) bytes += (await stat(path.join(directory, filename))).size;
  }
  return bytes;
}

test('compact PNG and WebP reports shrink actual assets without changing full-resolution comparison statistics', async t => {
  const { cwd, sources } = await fixture(t);
  const width = 128; const height = 256;
  const before = path.join(sources, 'before.png'); const after = path.join(sources, 'after.png');
  const baseline = noise(width, height); const current = Buffer.from(baseline);
  for (let y = 100; y < 112; y++) for (let x = 50; x < 62; x++) current.set([255, 0, 0, 255], (y * width + x) * 4);
  await image(before, width, height, baseline); await image(after, width, height, current);
  const manifest = path.join(cwd, 'pairs.json'); await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'checkout', before, after }] }));
  const fullDirectory = path.join(cwd, 'full report');
  const full = json(cwd, ['--manifest', manifest, '--html', '--output-dir', fullDirectory, '--fail-on-diff'], 1);
  const fullBytes = await assetBytes(fullDirectory, full);
  for (const imageFormat of ['png', 'webp']) {
    const output = path.join(cwd, `compact ${imageFormat}`);
    const compact = json(cwd, ['--manifest', manifest, '--html', '--relative', '--output-dir', output,
      '--max-height', '64', '--image-format', imageFormat, '--fail-on-diff'], 1);
    assert.deepEqual(compact.summary, full.summary);
    const settings = (compact as RunReport & { reportImages: { imageFormat: string; maxHeight: number } }).reportImages;
    assert.equal(settings.imageFormat, imageFormat); assert.equal(settings.maxHeight, 64);
    assert.ok(await assetBytes(output, compact) < fullBytes / 2, 'Compact assets should materially reduce this noisy screenshot report.');
    for (let i = 0; i < compact.results.length; i++) {
      const entry = compact.results[i]; const original = full.results[i];
      assert.notEqual(entry.status, 'error'); assert.notEqual(original.status, 'error');
      if (entry.status === 'error' || original.status === 'error') continue;
      assert.deepEqual(entry.stats, original.stats); assert.deepEqual(entry.comparison, original.comparison);
      assert.deepEqual([entry.before!.width, entry.before!.height], [width, height]);
      assert.deepEqual([entry.after!.width, entry.after!.height], [width, height]);
      assert.deepEqual([entry.output.width, entry.output.height], [32, 64]);
      assert.ok('reportImages' in entry, 'Per-pair metadata must distinguish rendered asset dimensions from comparison dimensions.');
      for (const filename of Object.values(entry.artifacts)) if (filename) {
        assert.equal(path.extname(filename), `.${imageFormat}`);
        const metadata = await sharp(await readFile(path.join(output, filename))).metadata();
        assert.equal(metadata.format, imageFormat); assert.equal(metadata.width, 32); assert.equal(metadata.height, 64);
      }
    }
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    for (const match of html.matchAll(/<img src="([^"]+)"/g)) await access(path.join(output, match[1]));
  }
  const standalone = path.join(cwd, 'full size standalone.png');
  const single = json<ReturnType<typeof comparisonReport>>(cwd, [before, after, '--html', '--relative', '--output', standalone,
    '--output-dir', path.join(cwd, 'single report'), '--max-height', '64', '--image-format', 'webp', '--fail-on-diff'], 1);
  assert.deepEqual(single.stats, full.results[0].status === 'error' ? null : full.results[0].stats);
  const fullMetadata = await sharp(await readFile(standalone)).metadata();
  assert.deepEqual([fullMetadata.format, fullMetadata.width, fullMetadata.height], ['png', width, height]);
});

test('compact report images never enlarge tiny screenshots and preserve missing-side semantics', async t => {
  const { cwd, sources } = await fixture(t);
  const baseline = path.join(sources, 'baseline'); const current = path.join(sources, 'current');
  await screenshot(baseline, 'removed.png', 2, 3); await screenshot(current, 'added.png', 3, 2);
  const output = path.join(cwd, 'tiny report');
  const report = json(cwd, [baseline, current, '--html', '--relative', '--output-dir', output, '--max-height', '100', '--image-format', 'webp']);
  assert.equal(report.summary.added, 1); assert.equal(report.summary.removed, 1);
  for (const entry of report.results) {
    if (entry.status === 'error') throw new Error(entry.error.message);
    const present = entry.before ?? entry.after!;
    assert.equal(entry.status === 'added' ? entry.artifacts.baseline : entry.artifacts.current, null);
    for (const filename of Object.values(entry.artifacts)) if (filename) {
      const metadata = await sharp(await readFile(path.join(output, filename))).metadata();
      assert.deepEqual([metadata.width, metadata.height], [present.width, present.height]);
      assert.equal(metadata.format, 'webp');
    }
  }
});

test('invalid report image settings fail before replacing an existing report', async t => {
  const { cwd, sources } = await fixture(t);
  const baseline = path.join(sources, 'baseline'); const current = path.join(sources, 'current');
  await screenshot(baseline, 'same.png'); await screenshot(current, 'same.png');
  const output = path.join(cwd, 'existing report');
  json(cwd, [baseline, current, '--html', '--output-dir', output]);
  const before = await readFile(path.join(output, 'results.json'));
  const cases = [
    ['--max-height', '0'], ['--max-height', '-1'], ['--max-height', '1.5'], ['--max-height', 'NaN'],
    ['--max-height', 'Infinity'], ['--max-height', ''], ['--image-format', 'jpeg'], ['--image-format', '']
  ];
  for (const args of cases) {
    const error = json<ReturnType<typeof errorReport>>(cwd, [baseline, current, '--html', '--output-dir', output, ...args], 2);
    assert.equal(error.status, 'error'); assert.match(error.error.message, /height|format/i);
    assert.deepEqual(await readFile(path.join(output, 'results.json')), before);
  }
});

test('report image options preserve input overwrite and reserved asset collision safeguards', async t => {
  const { cwd, sources } = await fixture(t);
  const before = await screenshot(sources, 'before.png'); const after = await screenshot(sources, 'after.png', 12, 8, [0, 0, 0, 255]);
  const original = await readPixels(before);
  const hardLink = path.join(cwd, 'source alias.png'); await link(before, hardLink);
  const protectedReport = path.join(cwd, 'protected report');
  const aliasError = json<ReturnType<typeof errorReport>>(cwd, [before, after, '--html', '--output-dir', protectedReport,
    '--output', hardLink, '--max-height', '4', '--image-format', 'webp', '--relative'], 2);
  assert.match(aliasError.error.message, /must not overwrite/);
  assert.deepEqual(await readPixels(before), original);
  const collisionReport = path.join(cwd, 'collision report');
  const hash = createHash('sha256').update('comparison').digest('hex');
  const reserved = path.join(collisionReport, 'assets', hash, 'current.png');
  const collision = json<ReturnType<typeof errorReport>>(cwd, [before, after, '--html', '--output-dir', collisionReport,
    '--output', reserved, '--max-height', '4', '--relative'], 2);
  assert.match(collision.error.message, /distinct|reserved|collid|asset|preview/i);
  assert.deepEqual(await readPixels(before), original);
  await assert.rejects(access(path.join(collisionReport, 'index.html')), { code: 'ENOENT' });
});

test('--relative after the option separator remains an input filename', async t => {
  const { sources } = await fixture(t);
  await screenshot(sources, '--relative'); await screenshot(sources, 'after.png');
  const report = JSON.parse(run(sources, ['--json', '--', '--relative', 'after.png']).stdout) as ReturnType<typeof comparisonReport>;
  assert.equal(report.status, 'identical'); assert.ok(path.isAbsolute(report.before!.path));
});
