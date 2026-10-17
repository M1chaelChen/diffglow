import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { image, pixels, workspace } from './helpers.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

function run(cwd: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd, encoding: 'utf8', timeout: 20_000
  });
  assert.equal(result.error, undefined);
  return result;
}

async function inputs(dir: string, changed = true): Promise<string[]> {
  const before = path.join(dir, 'before image.png');
  const after = path.join(dir, 'after image.png');
  await image(before, 8, 6);
  await image(after, 8, 6, pixels(8, 6, changed ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  return [before, after];
}

test('CLI writes the default diff.png and succeeds even when images differ', async t => {
  const dir = await workspace(t);
  const result = run(dir, await inputs(dir));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /48 changed pixels \(100%\)/);
  assert.ok(result.stdout.includes(path.join(dir, 'diff.png')));
  await access(path.join(dir, 'diff.png'));
});

test('CLI --fail-on-diff exits 1 after writing the requested image', async t => {
  const dir = await workspace(t);
  const output = path.join(dir, 'report', 'highlighted image.png');
  const result = run(dir, [...await inputs(dir), '--output', output, '--fail-on-diff']);
  assert.equal(result.status, 1, result.stderr);
  await access(output);
});

test('CLI --fail-on-diff still exits 0 for identical screenshots', async t => {
  const dir = await workspace(t);
  const result = run(dir, [...await inputs(dir, false), '--fail-on-diff']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0 changed pixels \(0%\)/);
});

test('CLI errors exit 2 with an explanation', async t => {
  const dir = await workspace(t);
  const files = await inputs(dir);
  const cases = [
    [], [files[0]], [...files, '--unknown'],
    [...files, '--threshold', 'bad'], [...files, '--threshold', ''],
    [...files, '--threshold=1.1'], ['missing.png', files[1]],
    [...files, '--output', files[0]]
  ];
  for (const args of cases) {
    const result = run(dir, args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /Error:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
});

test('CLI help works without inputs', async t => {
  const dir = await workspace(t);
  const result = run(dir, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /Usage: diffglow /);
  assert.match(result.stdout, /--fail-on-diff/);
});

test('CLI version matches the installed package metadata', async t => {
  const dir = await workspace(t);
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const result = run(dir, [flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), metadata.version);
  }
});

test('CLI reports an output failure with exit 2 and preserves the destination directory', async t => {
  const dir = await workspace(t);
  const output = path.join(dir, 'directory.png');
  await mkdir(output);
  const result = run(dir, [...await inputs(dir), '--output', output]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Cannot write output/);
  assert.equal((await stat(output)).isDirectory(), true);
});
