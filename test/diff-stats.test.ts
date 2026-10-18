import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { diffScreenshots, type DiffResult } from '../src/diff.js';
import { image, pixels, workspace } from './helpers.js';

function assertCountIdentities(result: DiffResult): void {
  assert.equal(result.changedPixels, result.modifiedPixels + result.addedPixels + result.removedPixels);
  assert.equal(result.comparedPixels, result.changedPixels + result.unchangedPixels);
  assert.equal(result.changedPercentage, result.changedPixels / result.comparedPixels * 100);
}

test('identical-image statistics have no bounds and record canonical input paths', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before image.png');
  const after = path.join(dir, 'after image.png');
  await image(before, 4, 3);
  await image(after, 4, 3);
  const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png') });
  assert.deepEqual({
    compared: result.comparedPixels, changed: result.changedPixels, unchanged: result.unchangedPixels,
    modified: result.modifiedPixels, added: result.addedPixels, removed: result.removedPixels,
    bounds: result.diffBounds, threshold: result.threshold
  }, { compared: 12, changed: 0, unchanged: 12, modified: 0, added: 0, removed: 0, bounds: null, threshold: 0.1 });
  assert.equal(result.beforePath, await realpath(before));
  assert.equal(result.afterPath, await realpath(after));
  assertCountIdentities(result);
});

test('a known rectangle reports shared modifications and exact tight bounds', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const candidate = pixels(8, 6);
  for (let y = 2; y < 4; y++) {
    for (let x = 3; x < 5; x++) candidate.set([0, 100, 200, 255], (y * 8 + x) * 4);
  }
  await image(before, 8, 6);
  await image(after, 8, 6, candidate);
  const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png') });
  assert.equal(result.modifiedPixels, 4);
  assert.equal(result.addedPixels, 0);
  assert.equal(result.removedPixels, 0);
  assert.equal(result.unchangedPixels, 44);
  assert.deepEqual(result.diffBounds, { x: 3, y: 2, width: 2, height: 2 });
  assertCountIdentities(result);
});

test('bounds span separate changed pixels, including the last row and column', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const candidate = pixels(7, 5);
  candidate.set([0, 0, 0, 255], 0);
  candidate.set([0, 0, 0, 255], (4 * 7 + 6) * 4);
  await image(before, 7, 5);
  await image(after, 7, 5, candidate);
  const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png') });
  assert.equal(result.modifiedPixels, 2);
  assert.equal(result.unchangedPixels, 33);
  assert.deepEqual(result.diffBounds, { x: 0, y: 0, width: 7, height: 5 });
  assertCountIdentities(result);
});

for (const kind of ['growth', 'shrink'] as const) {
  test(`${kind} statistics classify dimension-only pixels independently of threshold`, async t => {
    const dir = await workspace(t);
    const before = path.join(dir, 'before.png');
    const after = path.join(dir, 'after.png');
    await image(before, kind === 'growth' ? 2 : 4, 3);
    await image(after, kind === 'growth' ? 4 : 2, 3);
    const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png'), threshold: 1 });
    assert.equal(result.dimensionsChanged, true);
    assert.equal(result.comparedPixels, 12);
    assert.equal(result.changedPixels, 6);
    assert.equal(result.unchangedPixels, 6);
    assert.equal(result.modifiedPixels, 0);
    assert.equal(result.addedPixels, kind === 'growth' ? 6 : 0);
    assert.equal(result.removedPixels, kind === 'shrink' ? 6 : 0);
    assert.deepEqual(result.diffBounds, { x: 2, y: 0, width: 2, height: 3 });
    assertCountIdentities(result);
  });
}

test('crossed transparent dimensions exclude the empty corner and count both added and removed areas', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  await image(before, 4, 2, pixels(4, 2, [0, 0, 0, 0]));
  await image(after, 2, 4, pixels(2, 4, [0, 0, 0, 0]));
  const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png') });
  assert.deepEqual([result.width, result.height], [4, 4]);
  assert.equal(result.comparedPixels, 12);
  assert.equal(result.unchangedPixels, 4);
  assert.equal(result.modifiedPixels, 0);
  assert.equal(result.addedPixels, 4);
  assert.equal(result.removedPixels, 4);
  assert.deepEqual(result.diffBounds, { x: 0, y: 0, width: 4, height: 4 });
  assertCountIdentities(result);
});

test('shared modifications and both dimension-only categories can coexist without double counting', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const candidate = pixels(3, 4);
  candidate.set([0, 0, 0, 255], 0);
  candidate.set([0, 0, 0, 255], (2 * 3 + 2) * 4);
  await image(before, 4, 3);
  await image(after, 3, 4, candidate);
  const result = await diffScreenshots(before, after, { output: path.join(dir, 'diff.png') });
  assert.equal(result.comparedPixels, 15);
  assert.equal(result.modifiedPixels, 2);
  assert.equal(result.addedPixels, 3);
  assert.equal(result.removedPixels, 3);
  assert.equal(result.changedPixels, 8);
  assert.equal(result.unchangedPixels, 7);
  assert.deepEqual(result.diffBounds, { x: 0, y: 0, width: 4, height: 4 });
  assertCountIdentities(result);
});

test('sensitivity changes modification statistics and clears bounds when changes are tolerated', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  await image(before, 8, 6, pixels(8, 6, [100, 100, 100, 255]));
  await image(after, 8, 6, pixels(8, 6, [102, 102, 102, 255]));
  const strict = await diffScreenshots(before, after, { output: path.join(dir, 'strict.png'), threshold: 0 });
  const tolerant = await diffScreenshots(before, after, { output: path.join(dir, 'tolerant.png'), threshold: 1 });
  assert.equal(strict.threshold, 0);
  assert.equal(strict.modifiedPixels, 48);
  assert.equal(strict.unchangedPixels, 0);
  assert.deepEqual(strict.diffBounds, { x: 0, y: 0, width: 8, height: 6 });
  assert.equal(tolerant.threshold, 1);
  assert.equal(tolerant.modifiedPixels, 0);
  assert.equal(tolerant.unchangedPixels, 48);
  assert.equal(tolerant.diffBounds, null);
  assertCountIdentities(strict);
  assertCountIdentities(tolerant);
});
