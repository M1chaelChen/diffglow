import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectInputs } from '../src/discovery.js';
import { type IgnoreRegion } from '../src/regions.js';
import { image, pixel, pixels, readPixels, workspace } from './helpers.js';

const globalRegion = { x: 0, y: 0, width: 10, height: 2 };
const priceRegion = { x: 2, y: 3, width: 3, height: 1 };
const balanceRegion = { x: 5, y: 4, width: 4, height: 2 };
const dateRegion = { x: 1, y: 6, width: 5, height: 1 };

async function fixture(directory: string, filename: string) {
  const file = path.join(directory, filename);
  await mkdir(path.dirname(file), { recursive: true }); await image(file, 10, 8);
  return file;
}
async function folders(directory: string, names = ['catalog/product.png', 'account/balance.png', 'home.png']) {
  for (const name of names) {
    await fixture(directory, `baseline/${name}`); await fixture(directory, `current/${name}`);
  }
}
async function configFile(directory: string, value: unknown) {
  const file = path.join(directory, 'diffglow.config.json'); await writeFile(file, JSON.stringify(value)); return file;
}
const output = (directory: string) => path.join(directory, 'report');

function cliJson(directory: string, args: string[], expected = 0) {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args, '--json'], {
    cwd: directory, encoding: 'utf8', timeout: 20000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function fill(data: Buffer, width: number, region: IgnoreRegion) {
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
    data.set([0, 0, 0, 255], (y * width + x) * 4);
  }
}

test('ID rules add all matching masks to global rectangles without changing IDs or sort order', async t => {
  const directory = await workspace(t); await folders(directory);
  await configFile(directory, {
    ignoreRegions: [globalRegion],
    ignoreRegionsById: { '**/*.png': [dateRegion], 'catalog/**': [priceRegion], 'account/balance.png': [balanceRegion] }
  });
  const selected = await selectInputs([directory], { outputDirectory: output(directory) });
  assert.deepEqual(selected.ignoreRegions, [globalRegion]);
  assert.deepEqual(selected.pairs.map(pair => [pair.id, pair.ignoreRegions]), [
    ['account/balance.png', [globalRegion, dateRegion, balanceRegion]],
    ['catalog/product.png', [globalRegion, dateRegion, priceRegion]],
    ['home.png', [globalRegion, dateRegion]]
  ]);
  selected.pairs[0].ignoreRegions![0].width = 1;
  assert.equal(selected.ignoreRegions[0].width, 10);
  assert.equal(selected.pairs[1].ignoreRegions![0].width, 10);
});

test('explicit folders use pairing-template IDs for glob rules and preserve unmatched sides', async t => {
  const directory = await workspace(t);
  await fixture(directory, 'baseline/catalog/product.before.png');
  await fixture(directory, 'current/catalog/product.after.png');
  await fixture(directory, 'baseline/account/balance.before.png');
  await fixture(directory, 'current/account/date.after.png');
  const config = await configFile(directory, {
    baselinePattern: '{key}.before.{ext}', currentPattern: '{key}.after.{ext}',
    ignoreRegionsById: { 'catalog/*': [priceRegion], 'account/*': [balanceRegion] }
  });
  const selected = await selectInputs([path.join(directory, 'baseline'), path.join(directory, 'current')], { config, outputDirectory: output(directory) });
  assert.deepEqual(selected.pairs.map(pair => [pair.id, pair.ignoreRegions]), [
    ['account/balance', [balanceRegion]], ['account/date', [balanceRegion]], ['catalog/product', [priceRegion]]
  ]);
  assert.equal(selected.pairs[0].after, null); assert.equal(selected.pairs[1].before, null);
  assert.deepEqual(selected.ignoreRegions, []);
});

test('manifest masks append to matching rules while CLI rectangles replace only config global masks', async t => {
  const directory = await workspace(t); await fixture(directory, 'sources/before.png'); await fixture(directory, 'sources/after.png');
  const config = await configFile(directory, {
    ignoreRegions: [globalRegion], ignoreRegionsById: { 'catalog/*': [priceRegion], '**': [dateRegion] }
  });
  const manifest = path.join(directory, 'sources', 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [
    { id: 'home', before: 'before.png', after: 'after.png' },
    { id: 'catalog/product', before: 'before.png', after: 'after.png', ignoreRegions: [balanceRegion] }
  ] }));
  const selected = await selectInputs([], { manifest, config, ignoreRegions: [balanceRegion], outputDirectory: output(directory) });
  assert.deepEqual(selected.ignoreRegions, [balanceRegion]);
  assert.deepEqual(selected.pairs.map(pair => [pair.id, pair.ignoreRegions]), [
    ['catalog/product', [balanceRegion, priceRegion, dateRegion, balanceRegion]], ['home', [balanceRegion, dateRegion]]
  ]);
  assert.equal(selected.pairs[0].before, path.join(directory, 'sources', 'before.png'));
  const cleared = await selectInputs([], { manifest, config, ignoreRegions: [], outputDirectory: output(directory) });
  assert.deepEqual(cleared.ignoreRegions, []);
  assert.deepEqual(cleared.pairs[0].ignoreRegions, [priceRegion, dateRegion, balanceRegion]);
});

test('single-file comparison rules target comparison and do not alter input paths', async t => {
  const directory = await workspace(t); const before = await fixture(directory, 'before.png'); const after = await fixture(directory, 'after.png');
  const config = await configFile(directory, { ignoreRegions: [globalRegion], ignoreRegionsById: { comparison: [dateRegion], 'other/*': [priceRegion] } });
  const selected = await selectInputs([before, after], { config, outputDirectory: output(directory) });
  assert.equal(selected.mode, 'single');
  assert.deepEqual(selected.pairs, [{ id: 'comparison', before, after, ignoreRegions: [globalRegion, dateRegion] }]);
});

test('manifest IDs are user content: normalize separators only for matching and retain Unicode and markup', async t => {
  const directory = await workspace(t); const id = 'phone\\设置 <clock>&"';
  const config = await configFile(directory, { ignoreRegionsById: { 'phone/*': [globalRegion], '**/设置 <clock>&"': [dateRegion] } });
  const manifest = path.join(directory, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ id, before: 'missing-before.png', after: 'missing-after.png', ignoreRegions: [] }] }));
  const selected = await selectInputs([], { config, manifest, outputDirectory: output(directory) });
  assert.equal(selected.pairs[0].id, id);
  assert.deepEqual(selected.pairs[0].ignoreRegions, [globalRegion, dateRegion]);
  assert.equal(selected.pairs[0].before, path.join(directory, 'missing-before.png'));
});

test('invalid and unmatched rule masks fail eagerly without changing report output', async t => {
  const directory = await workspace(t); const before = await fixture(directory, 'before.png'); const after = await fixture(directory, 'after.png');
  await mkdir(output(directory)); await writeFile(path.join(output(directory), 'sentinel'), 'keep this');
  const invalid = [null, [], 'catalog/*', { 'unmatched/**': null }, { 'unmatched/**': [{ ...priceRegion, width: 0 }] },
    { 'unmatched/**': [{ ...priceRegion, selector: '.price' }] }, { 'unmatched/**': [{ ...priceRegion, x: 0.5 }] },
    { '': [] }, { 'catalog\\*': [] }, { 'catalog/[a]': [] }, { 'catalog**': [] }];
  for (const value of invalid) {
    const config = await configFile(directory, { ignoreRegionsById: value });
    await assert.rejects(selectInputs([before, after], { config, ignoreRegions: [], outputDirectory: output(directory) }), /ignore|glob|wildcard/i);
    assert.equal(await readFile(path.join(output(directory), 'sentinel'), 'utf8'), 'keep this');
    assert.deepEqual(await readdir(output(directory)), ['sentinel']);
  }
});

test('manifest ignore regions are strictly validated before any output and unknown pair options remain errors', async t => {
  const directory = await workspace(t); const manifest = path.join(directory, 'pairs.json');
  const invalidExtras = [
    { ignoreRegions: null }, { ignoreRegions: {} }, { ignoreRegions: [{ ...priceRegion, height: -1 }] },
    { ignoreRegions: [{ ...priceRegion, x: Number.MAX_SAFE_INTEGER }] }, { ignoreElements: ['.price'] },
    { ignoreRegions: [], extra: true }
  ];
  for (const extra of invalidExtras) {
    await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'catalog/product', before: 'before.png', after: 'after.png', ...extra }] }));
    await assert.rejects(selectInputs([], { manifest, outputDirectory: output(directory) }), /ignore|region|manifest pair/i);
    assert.ok(!(await readdir(directory)).includes('report'));
  }
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'catalog/product', before: 'before.png', ignoreRegions: [] }] }));
  await assert.rejects(selectInputs([], { manifest, outputDirectory: output(directory) }), /requires nonempty id, before, and after/);
});

test('empty rule maps preserve global masks and literal prototype-like IDs remain valid globs', async t => {
  const directory = await workspace(t); const before = await fixture(directory, 'before.png'); const after = await fixture(directory, 'after.png');
  const config = await configFile(directory, { ignoreRegions: [globalRegion], ignoreRegionsById: {} });
  const empty = await selectInputs([before, after], { config, outputDirectory: output(directory) });
  assert.deepEqual(empty.pairs[0].ignoreRegions, [globalRegion]);
  const specialRules: Record<string, IgnoreRegion[]> = Object.fromEntries([['__proto__', [priceRegion]], ['constructor', [dateRegion]]]);
  await configFile(directory, { ignoreRegionsById: specialRules });
  const manifest = path.join(directory, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: ['__proto__', 'constructor'].map(id => ({ id, before, after })) }));
  const selected = await selectInputs([], { manifest, config, outputDirectory: output(directory) });
  assert.deepEqual(selected.pairs.map(pair => [pair.id, pair.ignoreRegions]), [['__proto__', [priceRegion]], ['constructor', [dateRegion]]]);
});

test('CLI folder reports use per-ID rules for stats and highlights while run metadata stays global', async t => {
  const directory = await workspace(t); await folders(directory, ['catalog/product.png', 'account/balance.png']);
  for (const name of ['catalog/product.png', 'account/balance.png']) {
    const current = pixels(10, 8); fill(current, 10, globalRegion); fill(current, 10, priceRegion);
    if (name.startsWith('catalog/')) fill(current, 10, balanceRegion);
    await image(path.join(directory, 'current', name), 10, 8, current);
  }
  await configFile(directory, { ignoreRegions: [globalRegion], ignoreRegionsById: { 'catalog/*': [priceRegion] } });
  const report = cliJson(directory, [directory, '--output-dir', output(directory), '--html', '--fail-on-diff'], 1);
  assert.deepEqual(report.comparison.ignoreRegions, [globalRegion]);
  const [account, catalog] = report.results;
  assert.equal(account.id, 'account/balance.png');
  assert.deepEqual(account.comparison.ignoreRegions, [globalRegion]);
  assert.equal(account.stats.ignoredPixels, 20); assert.equal(account.stats.changedPixels, 3);
  assert.equal(catalog.id, 'catalog/product.png');
  assert.deepEqual(catalog.comparison.ignoreRegions, [globalRegion, priceRegion]);
  assert.equal(catalog.stats.ignoredPixels, 23); assert.equal(catalog.stats.changedPixels, 8);
  assert.equal(report.summary.ignoredPixels, 43); assert.equal(report.summary.comparedPixels, 117);
  assert.equal(report.summary.changedPixels, 11);
  const highlighted = await readPixels(path.join(output(directory), catalog.artifacts.diff));
  assert.deepEqual(pixel(highlighted, 10, 2, 3), [0, 0, 0, 255]);
  assert.deepEqual(pixel(highlighted, 10, 5, 4), [166, 0, 166, 255]);
  const html = await readFile(path.join(output(directory), 'index.html'), 'utf8');
  const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  assert.deepEqual(JSON.parse(embedded![1]).results[1].comparison.ignoreRegions, [globalRegion, priceRegion]);
});

test('CLI manifest masks suppress dynamic data, retain selected rules after a CLI override, and report zero differences', async t => {
  const directory = await workspace(t); const before = await fixture(directory, 'before.png');
  const after = path.join(directory, 'after.png'); const current = pixels(10, 8);
  for (const region of [globalRegion, priceRegion, balanceRegion]) fill(current, 10, region);
  await image(after, 10, 8, current);
  const config = await configFile(directory, { ignoreRegions: [dateRegion], ignoreRegionsById: { 'catalog/*': [priceRegion] } });
  const manifest = path.join(directory, 'pairs.json');
  await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'catalog/product', before, after, ignoreRegions: [balanceRegion] }] }));
  const report = cliJson(directory, ['--manifest', manifest, '--config', config, '--ignore-region', '0,0,10,2', '--output-dir', output(directory), '--html', '--fail-on-diff']);
  assert.deepEqual(report.comparison.ignoreRegions, [globalRegion]);
  assert.deepEqual(report.results[0].comparison.ignoreRegions, [globalRegion, priceRegion, balanceRegion]);
  assert.equal(report.results[0].status, 'identical');
  assert.equal(report.summary.changedPixels, 0); assert.equal(report.summary.ignoredPixels, 31);
  assert.equal(report.summary.comparedPixels, 49); assert.equal(report.summary.changedPercentage, 0);
  assert.deepEqual(await readPixels(path.join(output(directory), report.results[0].artifacts.diff)), await readPixels(after));
});

test('CLI single comparison applies its ID rule as well as selected global rectangles', async t => {
  const directory = await workspace(t); const before = await fixture(directory, 'before.png');
  const after = path.join(directory, 'after.png'); const current = pixels(10, 8); fill(current, 10, priceRegion);
  await image(after, 10, 8, current);
  const config = await configFile(directory, { ignoreRegions: [globalRegion], ignoreRegionsById: { comparison: [priceRegion] } });
  const report = cliJson(directory, [before, after, '--config', config, '--output', path.join(directory, 'diff.png'), '--fail-on-diff']);
  assert.deepEqual(report.comparison.ignoreRegions, [globalRegion, priceRegion]);
  assert.equal(report.status, 'identical'); assert.equal(report.stats.ignoredPixels, 23);
  assert.equal(report.stats.comparedPixels, 57); assert.equal(report.stats.changedPixels, 0);
});
