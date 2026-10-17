import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const inventory = {
  description: 'Runtime npm dependency inventory from package-lock.json, including platform-conditional optional dependencies. Native library contents carry additional notices in their upstream packages.',
  dependencies: Object.entries(lock.packages)
    .filter(([location, metadata]) => location !== '' && !metadata.dev)
    .map(([location, metadata]) => ({
      name: location.split('node_modules/').at(-1),
      version: metadata.version,
      license: metadata.license ?? 'UNKNOWN',
      optional: metadata.optional === true,
      ...(metadata.os ? { os: metadata.os } : {}),
      ...(metadata.cpu ? { cpu: metadata.cpu } : {}),
      source: metadata.resolved,
      integrity: metadata.integrity
    })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
};
assert.ok(inventory.dependencies.every(item => item.license !== 'UNKNOWN'), 'A runtime dependency has no declared license.');
const text = JSON.stringify(inventory, null, 2) + '\n';
const destination = new URL('../docs/dependency-licenses.json', import.meta.url);
if (process.argv.includes('--check')) {
  assert.equal(await readFile(destination, 'utf8'), text,
    'Dependency inventory is stale. Run npm run licenses:update and review license changes.');
} else {
  await writeFile(destination, text);
}
console.log(`${inventory.dependencies.length} runtime dependency licenses ${process.argv.includes('--check') ? 'verified' : 'recorded'}.`);
