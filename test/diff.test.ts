import assert from 'node:assert/strict';
import { link, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { diffScreenshots } from '../src/diff.js';
import { image, pixel, pixels, readPixels, workspace } from './helpers.js';

test('identical screenshots preserve every candidate pixel, including transparency', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const output = path.join(dir, 'highlighted.png');
  await image(before, 8, 6, pixels(8, 6, [40, 90, 180, 120]));
  await image(after, 8, 6, pixels(8, 6, [40, 90, 180, 120]));
  const result = await diffScreenshots(before, after, { output });
  assert.equal(result.changedPixels, 0);
  assert.equal(result.changedPercentage, 0);
  assert.equal(result.dimensionsChanged, false);
  assert.deepEqual(await readPixels(output), await readPixels(after));
});

test('a known changed rectangle is tinted over the candidate; all other pixels are untouched', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const output = path.join(dir, 'nested', 'highlighted.png');
  const candidate = pixels(8, 6);
  for (let y = 2; y < 4; y++) {
    for (let x = 3; x < 5; x++) candidate.set([0, 100, 200, 255], (y * 8 + x) * 4);
  }
  await image(before, 8, 6);
  await image(after, 8, 6, candidate);
  const result = await diffScreenshots(before, after, { output });
  assert.equal(result.changedPixels, 4);
  assert.equal(result.comparedPixels, 48);
  const highlighted = await readPixels(output);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      assert.deepEqual(pixel(highlighted, 8, x, y),
        x >= 3 && x < 5 && y >= 2 && y < 4 ? [166, 35, 236, 255] : [255, 255, 255, 255]);
    }
  }
});

for (const kind of ['added', 'removed'] as const) {
  test(`${kind} image area counts even at threshold 1 and is highlighted without resizing`, async t => {
    const dir = await workspace(t);
    const before = path.join(dir, 'before.png');
    const after = path.join(dir, 'after.png');
    const output = path.join(dir, 'highlighted.png');
    await image(before, kind === 'added' ? 2 : 4, 3);
    await image(after, kind === 'added' ? 4 : 2, 3);
    const result = await diffScreenshots(before, after, { output, threshold: 1 });
    assert.equal(result.changedPixels, 6);
    assert.equal(result.changedPercentage, 50);
    assert.equal(result.dimensionsChanged, true);
    assert.deepEqual([result.width, result.height], [4, 3]);
    const highlighted = await readPixels(output);
    assert.deepEqual(pixel(highlighted, 4, 0, 2), [255, 255, 255, 255]);
    assert.deepEqual(pixel(highlighted, 4, 3, 2), [255, 89, 255, 255]);
  });
}

test('transparent size changes count, while canvas areas belonging to neither image do not', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const output = path.join(dir, 'highlighted.png');
  await image(before, 4, 2, pixels(4, 2, [0, 0, 0, 0]));
  await image(after, 2, 4, pixels(2, 4, [0, 0, 0, 0]));
  const result = await diffScreenshots(before, after, { output });
  assert.equal(result.changedPixels, 8);
  assert.equal(result.comparedPixels, 12);
  assert.equal(result.changedPercentage, 8 / 12 * 100);
  const highlighted = await readPixels(output);
  assert.deepEqual(pixel(highlighted, 4, 3, 3), [0, 0, 0, 0]);
  assert.deepEqual(pixel(highlighted, 4, 3, 1), [255, 0, 255, 166]);
});

test('PNG and JPEG images can be compared', async t => {
  const dir = await workspace(t);
  const png = path.join(dir, 'before.png');
  const jpeg = path.join(dir, 'after.jpg');
  await image(png, 8, 6);
  await sharp(png).jpeg().toFile(jpeg);
  const result = await diffScreenshots(png, jpeg, { output: path.join(dir, 'result.png') });
  assert.equal(result.changedPixels, 0);
  assert.equal((await sharp(result.outputPath).metadata()).format, 'png');
});

test('JPEG EXIF orientation is normalized before alignment', async t => {
  const dir = await workspace(t);
  const png = path.join(dir, 'before.png');
  const jpeg = path.join(dir, 'after.jpg');
  const data = Buffer.from([10, 40, 80, 120, 170, 220].flatMap(v => [v, v, v, 255]));
  const rotated = Buffer.from([170, 80, 10, 220, 120, 40].flatMap(v => [v, v, v, 255]));
  await image(png, 3, 2, rotated);
  await sharp(data, { raw: { width: 2, height: 3, channels: 4 } })
    .withMetadata({ orientation: 6 }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(jpeg);
  const result = await diffScreenshots(png, jpeg, { output: path.join(dir, 'result.png') });
  assert.deepEqual(result.after, { width: 3, height: 2 });
  assert.equal(result.dimensionsChanged, false);
  assert.equal(result.changedPixels, 0);
});

test('threshold controls subtle color changes', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  await image(before, 8, 6, pixels(8, 6, [100, 100, 100, 255]));
  await image(after, 8, 6, pixels(8, 6, [102, 102, 102, 255]));
  const strict = await diffScreenshots(before, after, { output: path.join(dir, 'strict.png'), threshold: 0 });
  const tolerant = await diffScreenshots(before, after, { output: path.join(dir, 'tolerant.png'), threshold: 1 });
  assert.equal(strict.changedPixels, 48);
  assert.equal(tolerant.changedPixels, 0);
});

test('invalid thresholds are rejected', async () => {
  for (const threshold of [-0.1, 1.1, NaN, Infinity]) {
    await assert.rejects(diffScreenshots('before.png', 'after.png', { threshold }), /Threshold/);
  }
});

test('input paths and hard links cannot be used as output', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  await image(before, 8, 6);
  await image(after, 8, 6, pixels(8, 6, [0, 0, 0, 255]));
  const originalBefore = await readFile(before);
  const originalAfter = await readFile(after);
  const hard = path.join(dir, 'hard.png');
  await link(after, hard);
  for (const output of [before, after, hard]) {
    await assert.rejects(diffScreenshots(before, after, { output }), /must not overwrite/);
  }
  assert.deepEqual(await readFile(before), originalBefore);
  assert.deepEqual(await readFile(after), originalAfter);
});

test('symlinks cannot be used as output', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  const symbolic = path.join(dir, 'symbolic.png');
  await image(before, 8, 6);
  await image(after, 8, 6, pixels(8, 6, [0, 0, 0, 255]));
  const originalBefore = await readFile(before);
  try {
    await symlink(before, symbolic, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error instanceof Error &&
      'code' in error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('Windows does not grant file-symlink privileges to this process.');
      return;
    }
    throw error;
  }
  await assert.rejects(diffScreenshots(before, after, { output: symbolic }), /must not overwrite/);
  assert.deepEqual(await readFile(before), originalBefore);
});

test('missing, corrupt, and unsupported files produce clear errors', async t => {
  const dir = await workspace(t);
  const good = path.join(dir, 'good.png');
  const corrupt = path.join(dir, 'corrupt.png');
  const unsupported = path.join(dir, 'unsupported.gif');
  const output = path.join(dir, 'result.png');
  await image(good, 8, 6);
  await writeFile(corrupt, 'not an image');
  await sharp(good).gif().toFile(unsupported);
  await assert.rejects(diffScreenshots(path.join(dir, 'missing.png'), good, { output }), /Cannot read input/);
  await assert.rejects(diffScreenshots(corrupt, good, { output }), /Cannot decode/);
  await assert.rejects(diffScreenshots(unsupported, good, { output }), /only PNG and JPEG/);
  await assert.rejects(diffScreenshots(good, good, { output: path.join(dir, 'result.jpg') }), /\.png extension/);
});

test('cross-shaped image dimensions cannot trigger an unbounded canvas allocation', async t => {
  const dir = await workspace(t);
  const before = path.join(dir, 'before.png');
  const after = path.join(dir, 'after.png');
  await image(before, 10_000, 1);
  await image(after, 1, 10_000);
  await assert.rejects(diffScreenshots(before, after, { output: path.join(dir, 'result.png') }), /Combined image exceeds/);
});
