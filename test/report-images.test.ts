import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { normalizeReportImages, renderReportImage, type ReportImageOptions } from '../src/report-images.js';
import { image, pixels, readPixels, workspace } from './helpers.js';

test('report image options default to full-size PNG and strictly validate before reading or writing', async t => {
  const directory = await workspace(t);
  assert.deepEqual(normalizeReportImages(), { maxHeight: null, imageFormat: 'png' });
  assert.deepEqual(normalizeReportImages({ maxHeight: 720, imageFormat: 'webp' }), { maxHeight: 720, imageFormat: 'webp' });
  for (const maxHeight of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '720', true]) {
    assert.throws(() => normalizeReportImages({ maxHeight }), /max height.*positive safe integer/i);
  }
  for (const imageFormat of [null, '', 'jpeg', 'WebP', 1, true]) {
    assert.throws(() => normalizeReportImages({ imageFormat }), /image format.*png.*webp/i);
  }
  const destination = path.join(directory, 'existing.png');
  await writeFile(destination, 'preserve this destination');
  const source = path.join(directory, 'missing.png');
  for (const options of [{ maxHeight: 0, imageFormat: 'png' }, { maxHeight: null, imageFormat: 'jpeg' }]) {
    await assert.rejects(renderReportImage(source, destination, options as ReportImageOptions), /Report (max height|image format)/);
    assert.equal(await readFile(destination, 'utf8'), 'preserve this destination');
  }
  assert.deepEqual(await readdir(directory), ['existing.png']);
});

test('max height preserves aspect ratio, never enlarges, and reports encoded dimensions', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.png');
  await image(source, 27, 60);
  const original = await readFile(source);
  const resized = path.join(directory, 'resized.png');
  const options = normalizeReportImages({ maxHeight: 20 });
  assert.deepEqual(await renderReportImage(source, resized, options), { width: 9, height: 20 });
  const metadata = await sharp(await readFile(resized)).metadata();
  assert.equal(metadata.width, 9); assert.equal(metadata.height, 20);
  assert.equal(metadata.format, 'png');
  assert.deepEqual(await readFile(source), original);

  const largeLimit = path.join(directory, 'unchanged.png');
  assert.deepEqual(await renderReportImage(source, largeLimit, normalizeReportImages({ maxHeight: 300 })), { width: 27, height: 60 });
  assert.deepEqual(await readFile(largeLimit), original);
});

test('default PNG keeps exact bytes, including alpha, at the same or a separate destination', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.png');
  const rgba = pixels(3, 2, [123, 50, 200, 100]);
  rgba.set([22, 80, 140, 0], 0);
  await image(source, 3, 2, rgba);
  const original = await readFile(source);
  const options = normalizeReportImages();
  assert.deepEqual(await renderReportImage(source, source, options), { width: 3, height: 2 });
  assert.deepEqual(await readFile(source), original);
  const copy = path.join(directory, 'copy.png');
  await renderReportImage(source, copy, options);
  assert.deepEqual(await readFile(copy), original);
  assert.deepEqual((await readFile(copy)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.deepEqual(await readPixels(copy), rgba);
});

test('lossless WebP preserves every RGBA pixel, including colors under transparency, without changing source', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.png');
  const rgba = Buffer.from([
    5, 20, 200, 255, 143, 70, 40, 128, 30, 67, 210, 0,
    255, 70, 9, 100, 100, 50, 20, 1, 230, 2, 50, 255
  ]);
  await image(source, 3, 2, rgba);
  const original = await readFile(source);
  const destination = path.join(directory, 'image.webp');
  assert.deepEqual(await renderReportImage(source, destination, normalizeReportImages({ imageFormat: 'webp' })), { width: 3, height: 2 });
  const webp = await readFile(destination);
  assert.equal(webp.subarray(0, 4).toString(), 'RIFF');
  assert.equal(webp.subarray(8, 12).toString(), 'WEBP');
  assert.deepEqual(await readPixels(destination), rgba);
  assert.deepEqual(await readFile(source), original);
});

test('same-path conversion safely replaces only the completed encoded image and leaves no temporary files', async t => {
  const directory = await workspace(t);
  for (const imageFormat of ['png', 'webp'] as const) {
    const source = path.join(directory, `report-${imageFormat}.png`);
    await image(source, 14, 10, pixels(14, 10, [0, 145, 210, 128]));
    assert.deepEqual(await renderReportImage(source, source, normalizeReportImages({ maxHeight: 5, imageFormat })), { width: 7, height: 5 });
    // Buffer reads avoid retaining native WebP file handles during Windows cleanup.
    const metadata = await sharp(await readFile(source)).metadata();
    assert.equal(metadata.format, imageFormat); assert.equal(metadata.width, 7); assert.equal(metadata.height, 5);
  }
  assert.deepEqual(await readdir(directory), ['report-png.png', 'report-webp.png']);
});

test('oversized WebP reports fail clearly before overwriting any image and can be resized to fit', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'wide.png');
  await image(source, 16_384, 4);
  const original = await readFile(source);
  const options = normalizeReportImages({ imageFormat: 'webp' });
  await assert.rejects(renderReportImage(source, source, options), /WebP.*16383.*--max-height/);
  assert.deepEqual(await readFile(source), original);
  const destination = path.join(directory, 'existing.webp');
  await writeFile(destination, 'keep this destination');
  await assert.rejects(renderReportImage(source, destination, options), /WebP.*16383.*--max-height/);
  assert.equal(await readFile(destination, 'utf8'), 'keep this destination');
  assert.deepEqual(await renderReportImage(source, destination, normalizeReportImages({ maxHeight: 2, imageFormat: 'webp' })), { width: 8192, height: 2 });
  assert.equal((await sharp(await readFile(destination)).metadata()).format, 'webp');
  assert.deepEqual(await readdir(directory), ['existing.webp', 'wide.png']);
});

test('encoding errors preserve an existing destination and leave no temporary files', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'broken.png');
  const destination = path.join(directory, 'existing.webp');
  await writeFile(source, 'invalid image');
  await writeFile(destination, 'keep this destination');
  await assert.rejects(renderReportImage(source, destination, normalizeReportImages({ imageFormat: 'webp' })), /unsupported image format/);
  assert.equal(await readFile(destination, 'utf8'), 'keep this destination');
  assert.deepEqual(await readdir(directory), ['broken.png', 'existing.webp']);
});

test('failed destination replacement cleans the temporary image and preserves source and destination contents', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.png');
  const destination = path.join(directory, 'existing');
  await image(source, 4, 4);
  const original = await readFile(source);
  await mkdir(destination);
  await writeFile(path.join(destination, 'marker.txt'), 'keep destination');
  await assert.rejects(renderReportImage(source, destination, normalizeReportImages({ maxHeight: 2, imageFormat: 'webp' })));
  assert.deepEqual(await readFile(source), original);
  assert.equal(await readFile(path.join(destination, 'marker.txt'), 'utf8'), 'keep destination');
  assert.deepEqual(await readdir(directory), ['existing', 'source.png']);
});
