import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { diffScreenshots } from '../src/diff.js';

interface Example {
  id: string;
  title: string;
  description: string;
  before: string;
  after: string;
  allowedBounds?: { x: number; y: number; right: number; bottom: number };
}
const root = new URL('./gallery/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('captures.json', root), 'utf8')) as {
  browser: string; source: string; cases: Example[];
};
const results = [];
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function verifyCLI(before: string, after: string, output: string, expectedChanges: number): void {
  const result = spawnSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), cli, before, after, '--output', output, '--fail-on-diff'
  ], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedChanges > 0 ? 1 : 0, result.stderr);
  assert.ok(result.stdout.includes(`${expectedChanges.toLocaleString('en-US')} changed pixels`));
}

for (const example of manifest.cases) {
  const before = fileURLToPath(new URL(example.before, root));
  const after = fileURLToPath(new URL(example.after, root));
  const output = fileURLToPath(new URL(`${example.id}/highlighted.png`, root));
  const result = await diffScreenshots(before, after, { output });
  assert.ok(result.changedPixels > 0, `${example.id}: should detect the deliberate change`);
  verifyCLI(before, after, output, result.changedPixels);

  const { data: actual, info } = await sharp(after).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const highlighted = await sharp(output).ensureAlpha().raw().toBuffer();
  let altered = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = (y * info.width + x) * 4;
      const b = (y * result.width + x) * 4;
      if (actual.subarray(a, a + 4).equals(highlighted.subarray(b, b + 4))) continue;
      altered++;
      if (example.allowedBounds) {
        const bounds = example.allowedBounds;
        assert.ok(x >= bounds.x && y >= bounds.y && x < bounds.right && y < bounds.bottom,
          `${example.id}: unexpected highlight outside the deliberately changed element at ${x}, ${y}`);
      }
    }
  }
  assert.equal(altered, result.changedPixels, `${example.id}: count agrees with visible highlights`);
  if (example.id === 'page-growth') {
    assert.equal(result.changedPixels, 900 * 180);
    assert.deepEqual(result.before, { width: 900, height: 600 });
    assert.deepEqual(result.after, { width: 900, height: 780 });
  }

  const columnWidth = 400;
  const panelWidth = 1280;
  const headerHeight = 124;
  const previews = await Promise.all([before, after, output].map(async filename => {
    const { data, info } = await sharp(filename).resize({ width: columnWidth }).png().toBuffer({ resolveWithObject: true });
    return { data, height: info.height };
  }));
  const panelHeight = headerHeight + Math.max(...previews.map(p => p.height)) + 24;
  const header = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${headerHeight}"><rect width="100%" height="100%" fill="#f4f6fa"/><g font-family="Arial,sans-serif"><text x="24" y="33" font-size="23" font-weight="700" fill="#17243b">${escape(example.title)}</text><text x="24" y="58" font-size="13" fill="#64748b">${escape(example.description)}</text><text x="24" y="81" font-size="12" fill="#64748b">${result.changedPixels.toLocaleString('en-US')} changed pixels · ${result.changedPercentage.toFixed(2)}% · Original pixels compared; previews scaled for display</text><text x="24" y="112" font-size="13" font-weight="700" fill="#17243b">BEFORE</text><text x="440" y="112" font-size="13" font-weight="700" fill="#17243b">AFTER</text><text x="856" y="112" font-size="13" font-weight="700" fill="#ad168a">HIGHLIGHTED DIFF</text></g></svg>`);
  await sharp({ create: { width: panelWidth, height: panelHeight, channels: 4, background: '#f4f6fa' } })
    .composite([
      { input: header, left: 0, top: 0 },
      ...previews.map((preview, i) => ({ input: preview.data, left: 24 + i * 416, top: headerHeight }))
    ]).png().toFile(fileURLToPath(new URL(`${example.id}/comparison.png`, root)));
  results.push({
    id: example.id, changedPixels: result.changedPixels, changedPercentage: result.changedPercentage,
    before: result.before, after: result.after, highlighted: `${example.id}/highlighted.png`, comparison: `${example.id}/comparison.png`, verified: true
  });
  console.log(`${example.title}: ${result.changedPixels.toLocaleString('en-US')} pixels (${result.changedPercentage.toFixed(2)}%) — verified`);
}

const first = manifest.cases[0];
const unchanged = await diffScreenshots(
  fileURLToPath(new URL(first.before, root)), fileURLToPath(new URL(first.before, root)),
  { output: fileURLToPath(new URL('unchanged.png', root)) }
);
assert.equal(unchanged.changedPixels, 0);
verifyCLI(fileURLToPath(new URL(first.before, root)), fileURLToPath(new URL(first.before, root)), unchanged.outputPath, 0);
console.log('Unchanged screenshot control: 0 changed pixels — verified');

const growth = manifest.cases.find(example => example.id === 'page-growth')!;
const shrink = await diffScreenshots(
  fileURLToPath(new URL(growth.after, root)), fileURLToPath(new URL(growth.before, root)),
  { output: fileURLToPath(new URL('page-growth/removed-content.png', root)) }
);
assert.equal(shrink.changedPixels, 900 * 180);
assert.equal(shrink.height, 780);
verifyCLI(fileURLToPath(new URL(growth.after, root)), fileURLToPath(new URL(growth.before, root)), shrink.outputPath, 162_000);
console.log('Removed page section control: 162,000 changed pixels — verified');

await writeFile(new URL('results.json', root), JSON.stringify({
  browser: manifest.browser, cases: results, controls: { unchangedPixels: unchanged.changedPixels, removedSectionPixels: shrink.changedPixels }
}, null, 2) + '\n');

const cards = manifest.cases.map(example => `<section><h2>${escape(example.title)}</h2><p>${escape(example.description)}</p><a href="${example.id}/comparison.png"><img src="${example.id}/comparison.png" alt="Before, after, and highlighted difference for ${escape(example.title)}"></a><p><a href="${example.before}">Full-size before</a> · <a href="${example.after}">Full-size after</a> · <a href="${example.id}/highlighted.png">Full-size highlighted diff</a></p></section>`).join('\n');
await writeFile(new URL('index.html', root), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Screenshot diff verification gallery</title><style>body{margin:32px auto;padding:0 20px;max-width:1280px;font:15px/1.6 Arial,sans-serif;color:#17243b;background:#f4f6fa}h1{font-size:30px}h2{margin-bottom:0}section{margin:36px 0 60px}img{width:100%;height:auto;border:1px solid #dce2eb;border-radius:10px}a{color:#345fcd}p{color:#64748b}</style><h1>Screenshot diff verification gallery</h1><p>Controlled HTML fixtures captured in ${escape(manifest.browser)}. The mobile example is a browser viewport fixture, not a React Native capture. Magenta marks changed pixels. Click an image to enlarge it.</p>${cards}<p>Additional controls passed: identical screenshots produced zero changes; reversing the page-height case highlighted the removed section.</p></html>`);
