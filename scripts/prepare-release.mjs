import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versionParts } from './release-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.name !== 'diffglow') throw new Error('Prepare an explicitly versioned Diffglow release.');
versionParts(pkg.version);
const directory = path.join(root, 'artifacts', 'release', pkg.version);
await mkdir(directory, { recursive: true });
const revision = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
const sourceStatus = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
const log = [];
const manifest = {
  package: `${pkg.name}@${pkg.version}`,
  preparedAt: new Date().toISOString(),
  platform: process.platform, architecture: process.arch, node: process.version,
  sourceCommit: revision.status === 0 ? revision.stdout.trim() : null,
  sourceHasUncommittedChanges: sourceStatus.status === 0 ? sourceStatus.stdout.trim().length > 0 : null,
  status: 'running',
  readyToLaunch: false,
  checks: [],
  requiredBeforeLaunch: [
    'A successful release.yml run must verify the same candidate on Linux, macOS, and Windows with Node.js 22 and 24.',
    'A maintainer must review the public source and demonstration screenshots.',
    'Explicit launch authorization, available package/repository names, npm authentication, and 2FA are required for public writes.'
  ],
  publication: 'No repository, registry entry, Git tag, or GitHub release is created by this command.'
};
const manifestFile = path.join(directory, 'release-manifest.json');
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command with npm run release:prepare.');

async function run(name) {
  const startedAt = new Date().toISOString();
  console.log(`\nRelease preparation: ${name}`);
  log.push(`\nRelease preparation: ${name}\n`);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, 'run', name], {
      cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { process.stdout.write(chunk); log.push(chunk.toString()); });
    child.stderr.on('data', chunk => { process.stderr.write(chunk); log.push(chunk.toString()); });
    child.on('error', reject);
    child.on('close', resolve);
  });
  manifest.checks.push({ name, status: result === 0 ? 'passed' : 'failed', startedAt, completedAt: new Date().toISOString() });
  if (result !== 0) throw new Error(`${name} failed; release preparation stopped.`);
}

try {
  for (const task of ['typecheck', 'test', 'build', 'examples:verify', 'licenses:check', 'verify:package', 'audit:public']) {
    await run(task);
  }
  await mkdir(path.join(directory, 'screenshots'), { recursive: true });
  for (const name of ['before.png', 'after.png', 'highlighted.png']) {
    await copyFile(path.join(root, 'examples', name), path.join(directory, 'screenshots', name));
  }
  await copyFile(path.join(root, 'docs', 'demo.png'), path.join(directory, 'screenshots', 'demo.png'));
  await copyFile(path.join(root, 'docs', 'dependency-licenses.json'), path.join(directory, 'dependency-licenses.json'));
  await copyFile(path.join(root, 'CHANGELOG.md'), path.join(directory, 'RELEASE_NOTES.md'));
  await copyFile(path.join(root, 'docs', 'releasing.md'), path.join(directory, 'RELEASING.md'));
  const announcement = await readFile(path.join(root, 'docs', 'launch-announcement.md'), 'utf8');
  await writeFile(path.join(directory, 'ANNOUNCEMENT.md'), announcement
    .replace('(releasing.md)', '(RELEASING.md)').replace('(demo.png)', '(screenshots/demo.png)'));
  manifest.status = 'passed-local-checks';
  console.log(`\nReview bundle: artifacts/release/${pkg.version}/`);
  console.log('This environment passed. The six-platform CI matrix and maintainer review remain launch gates.');
} catch (error) {
  manifest.status = 'failed';
  process.exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  log.push(`${message}\n`);
} finally {
  manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'validation.log'), log.join(''));
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  // Keep results from both locally tested Node versions instead of replacing them.
  const environment = `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`;
  const evidence = path.join(directory, 'verification', environment);
  await mkdir(evidence, { recursive: true });
  for (const name of ['package-report.json', 'public-audit.json', 'release-manifest.json', 'validation.log']) {
    try {
      await copyFile(path.join(directory, name), path.join(evidence, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function files(folder, prefix = '') {
    const result = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) result.push(...await files(path.join(folder, entry.name), relative));
      else if (relative !== 'SHA256SUMS') result.push(relative);
    }
    return result;
  }
  const sums = [];
  for (const relative of (await files(directory)).sort()) {
    const digest = createHash('sha256').update(await readFile(path.join(directory, relative))).digest('hex');
    sums.push(`${digest}  ${relative}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
}
