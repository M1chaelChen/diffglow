import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fixtures } from './fixtures.mjs';

// Browser capture is an optional fixture-generation dependency, not part of the CLI.
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
const root = new URL('./', import.meta.url);
const browser = await chromium.launch({ headless: true });
const manifest = [];
try {
  for (const fixture of fixtures) {
    const context = await browser.newContext({
      viewport: { width: fixture.width, height: fixture.height },
      deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce'
    });
    const page = await context.newPage();
    // Fixtures are self-contained; no network requests are needed.
    await context.route(/^https?:/, route => route.abort());
    const directory = new URL(`${fixture.id}/`, root);
    await mkdir(directory, { recursive: true });
    const captures = {};
    const boxes = [];
    for (const side of ['before', 'after']) {
      await page.setContent(fixture[side], { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      if (fixture.selector) boxes.push(await page.locator(fixture.selector).boundingBox());
      const filename = `${side}.${fixture.format === 'jpeg' ? 'jpg' : 'png'}`;
      await page.screenshot({
        path: fileURLToPath(new URL(filename, directory)),
        type: fixture.format, quality: fixture.format === 'jpeg' ? 98 : undefined,
        fullPage: fixture.fullPage ?? false, animations: 'disabled'
      });
      captures[side] = `${fixture.id}/${filename}`;
    }
    const bounds = boxes.filter(Boolean);
    const padding = fixture.format === 'jpeg' ? 16 : 2;
    const allowedBounds = bounds.length ? {
      x: Math.max(0, Math.floor(Math.min(...bounds.map(b => b.x))) - padding),
      y: Math.max(0, Math.floor(Math.min(...bounds.map(b => b.y))) - padding),
      right: Math.ceil(Math.max(...bounds.map(b => b.x + b.width))) + padding,
      bottom: Math.ceil(Math.max(...bounds.map(b => b.y + b.height))) + padding
    } : undefined;
    manifest.push({ id: fixture.id, title: fixture.title, description: fixture.description, ...captures, allowedBounds });
    console.log(`Captured ${fixture.id} (${fixture.format})`);
    await context.close();
  }
  await writeFile(new URL('captures.json', root), JSON.stringify({
    browser: `Chromium ${browser.version()}`, source: 'Self-contained HTML test fixtures', cases: manifest
  }, null, 2) + '\n');
} finally {
  await browser.close();
}
