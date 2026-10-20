import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { image, pixels, readPixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd, encoding: 'utf8', timeout: 20_000
  });
  assert.equal(result.error, undefined);
  return result;
}

async function inputs(dir: string, changed = true) {
  const before = path.join(dir, 'before image.png');
  const after = path.join(dir, 'after image.png');
  await image(before, 8, 6);
  const candidate = pixels(8, 6);
  if (changed) for (let y = 2; y < 4; y++) {
    for (let x = 3; x < 5; x++) candidate.set([0, 100, 200, 255], (y * 8 + x) * 4);
  }
  await image(after, 8, 6, candidate);
  return { before, after };
}

test('JSON mode emits one formatted success document with accurate statistics and spaced paths', async t => {
  const dir = await workspace(t);
  const { before, after } = await inputs(dir);
  const output = path.join(dir, 'nested directory', 'highlighted image.png');
  const result = run(dir, [path.basename(before), path.basename(after), '--json', '-o', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const json = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(json, null, 2) + '\n');
  assert.deepEqual(json, {
    schemaVersion: 1,
    status: 'different',
    before: { path: await realpath(before), width: 8, height: 6 },
    after: { path: await realpath(after), width: 8, height: 6 },
    output: { path: output, width: 8, height: 6 },
    rendering: { highlightColor: '#ff00ff', highlightOpacity: 0.65 },
    comparison: { threshold: 0.1, includeAntiAliasing: false, alignment: 'top-left', ignoreRegions: [], dimensionsChanged: false },
    stats: {
      comparedPixels: 48, ignoredPixels: 0, changedPixels: 4, unchangedPixels: 44, changedPercentage: 4 / 48 * 100,
      modifiedPixels: 4, addedPixels: 0, removedPixels: 0,
      diffBounds: { x: 3, y: 2, width: 2, height: 2 }
    },
    exitCode: 0
  });
  assert.equal((await readPixels(output)).length, 8 * 6 * 4);
});

test('JSON fail-on-diff exit 1 still saves the requested highlighted image', async t => {
  const dir = await workspace(t);
  const { before, after } = await inputs(dir);
  const output = path.join(dir, 'highlighted.png');
  const result = run(dir, ['--json', before, after, '-o', output, '--fail-on-diff']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'different');
  assert.equal(json.exitCode, 1);
  assert.equal(json.stats.changedPixels, 4);
  await access(output);
  assert.notDeepEqual(await readPixels(output), await readPixels(after));
});

test('JSON identical case exits 0 with null bounds and an unchanged default output', async t => {
  const dir = await workspace(t);
  const { before, after } = await inputs(dir, false);
  const result = run(dir, [before, after, '--json', '--fail-on-diff']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const json = JSON.parse(result.stdout);
  assert.equal(json.status, 'identical');
  assert.equal(json.exitCode, 0);
  assert.deepEqual(json.stats, {
    comparedPixels: 48, ignoredPixels: 0, changedPixels: 0, unchangedPixels: 48, changedPercentage: 0,
    modifiedPixels: 0, addedPixels: 0, removedPixels: 0, diffBounds: null
  });
  assert.equal(path.isAbsolute(json.output.path), true);
  // Windows may expose the child process cwd through its equivalent 8.3 alias.
  assert.equal(await realpath(json.output.path), await realpath(path.join(dir, 'diff.png')));
  assert.deepEqual(await readPixels(json.output.path), await readPixels(after));
});

test('JSON dimension statistics serialize added and removed areas and custom sensitivity', async t => {
  const dir = await workspace(t);
  const small = path.join(dir, 'small.png');
  const large = path.join(dir, 'large.png');
  await image(small, 2, 3);
  await image(large, 4, 3);
  for (const [before, after, added, removed] of [[small, large, 6, 0], [large, small, 0, 6]] as const) {
    const result = run(dir, [before, after, '--json', '--threshold', '1']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const json = JSON.parse(result.stdout);
    assert.deepEqual(json.comparison, { threshold: 1, includeAntiAliasing: false, alignment: 'top-left', ignoreRegions: [], dimensionsChanged: true });
    assert.deepEqual([json.output.width, json.output.height], [4, 3]);
    assert.deepEqual(json.stats, {
      comparedPixels: 12, ignoredPixels: 0, changedPixels: 6, unchangedPixels: 6, changedPercentage: 50,
      modifiedPixels: 0, addedPixels: added, removedPixels: removed,
      diffBounds: { x: 2, y: 0, width: 2, height: 3 }
    });
  }
});

test('JSON errors cover arguments, decoding, input protection, and output failures without stderr', async t => {
  const dir = await workspace(t);
  const { before, after } = await inputs(dir);
  const corrupt = path.join(dir, 'corrupt.png');
  const directory = path.join(dir, 'directory.png');
  await writeFile(corrupt, 'not an image');
  await mkdir(directory);
  const original = await readFile(before);
  const cases = [
    { args: ['--json'], message: /exactly two input images/ },
    { args: ['--unknown', '--json'], message: /Unknown option/ },
    { args: ['--json', before, after, '--threshold'], message: /argument|value/i },
    { args: [before, after, '--threshold', 'bad', '--json'], message: /Threshold/ },
    { args: [before, after, '--threshold=1.1', '--json'], message: /Threshold/ },
    { args: ['missing.png', after, '--json'], message: /Cannot read input/ },
    { args: [corrupt, after, '--json'], message: /Cannot decode/ },
    { args: [before, after, '-o', before, '--json'], message: /must not overwrite/ },
    { args: [before, after, '-o', directory, '--json'], message: /Cannot write output/ }
  ];
  for (const { args, message } of cases) {
    const result = run(dir, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    const json = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(json).sort(), ['error', 'exitCode', 'schemaVersion', 'status']);
    assert.deepEqual(Object.keys(json.error), ['message']);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.status, 'error');
    assert.equal(json.exitCode, 2);
    assert.match(json.error.message, message);
    assert.doesNotMatch(json.error.message, /\n\s+at /);
  }
  assert.deepEqual(await readFile(before), original);
  assert.equal((await stat(directory)).isDirectory(), true);
});

test('a positional file named --json after -- does not enable JSON output', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, '--json');
  const after = path.join(dir, 'after.png');
  await image(before, 3, 2);
  await image(after, 3, 2);
  const text = run(dir, ['--', '--json', 'after.png']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stderr, '');
  assert.match(text.stdout, /^0 changed pixels \(0%\)\.\nHighlighted image: /);
  assert.throws(() => JSON.parse(text.stdout));
  const jsonResult = run(dir, ['--json', '--', '--json', 'after.png']);
  assert.equal(jsonResult.status, 0, jsonResult.stderr);
  assert.equal(JSON.parse(jsonResult.stdout).before.path, await realpath(before));
  const error = run(dir, ['--unknown', '--', '--json', 'after.png']);
  assert.equal(error.status, 2);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /^Error:/);
});

test('help and version remain text when JSON is requested', async t => {
  const dir = await workspace(t);
  const help = run(dir, ['--json', '--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /^Usage: diffglow /);
  assert.match(help.stdout, /--json/);
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = run(dir, ['--json', '--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stderr, '');
  assert.equal(version.stdout, metadata.version + '\n');
});

test('omitting JSON preserves the existing human-readable report', async t => {
  const dir = await workspace(t);
  const { before, after } = await inputs(dir);
  const output = path.join(dir, 'human-readable.png');
  const result = run(dir, [before, after, '-o', output]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `4 changed pixels (8.333333%).\nHighlighted image: ${output}\n`);
});
