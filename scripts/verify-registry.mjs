import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCandidate, registry, releaseContext, releaseChannel, waitForPublication } from './release-utils.mjs';

const context = releaseContext();
const candidate = await readCandidate(context);
await waitForPublication(context.version, candidate.integrity);
assert.ok(process.env.npm_execpath, 'Run through npm run release:verify-registry.');
const consumer = await mkdtemp(path.join(os.tmpdir(), 'diffglow-registry-consumer-'));
const env = { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '', npm_config_cache: path.join(consumer, 'cache') };
delete env.NODE_PATH; delete env.NODE_OPTIONS;
function run(args, cwd) {
  const child = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit', timeout: 180_000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, 'Fresh registry consumer check failed.');
}
try {
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'diffglow-registry-check', private: true }));
  run([process.env.npm_execpath, 'install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false',
    '--registry', registry, `diffglow@${context.version}`], consumer);
  const installed = JSON.parse(await readFile(path.join(consumer, 'node_modules/diffglow/package.json'), 'utf8'));
  assert.equal(installed.name, 'diffglow'); assert.equal(installed.version, context.version);
  const result = path.join(consumer, 'consumer-checks.json');
  run([fileURLToPath(new URL('./verify-package.mjs', import.meta.url)), '--consumer-check', consumer, result], process.cwd());
  const checks = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(checks.status, 'passed');
  await writeFile(path.join(context.directory, 'registry-verification.json'), JSON.stringify({
    status: 'passed', package: `diffglow@${context.version}`, sourceCommit: context.sha,
    integrity: candidate.integrity, checks: checks.checks
  }, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### Registry verification passed\n\nFresh production installation of diffglow@${context.version} passed ${checks.checks.length} installed CLI checks. Registry integrity and ${releaseChannel(context.version)} tag match the audited candidate.\n`);
} finally { await rm(consumer, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
