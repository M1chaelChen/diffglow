import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { publishDecision, readCandidate, registry, registryJSON, releaseContext, waitForPublication } from './release-utils.mjs';

const context = releaseContext();
const candidate = await readCandidate(context);
const metadata = await registryJSON(`/${encodeURIComponent(context.version)}`);
const tags = await registryJSON('/dist-tags');
const shouldPublish = publishDecision(metadata, tags, context.version, candidate.integrity);
if (shouldPublish) {
  assert.ok(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'GitHub OIDC must be available.');
  assert.ok(process.env.npm_execpath, 'Run through npm run release:publish.');
  console.log(`Publishing reviewed diffglow@${context.version}; SHA-256 ${candidate.sha256}`);
  const child = spawnSync(process.execPath, [process.env.npm_execpath, 'publish', candidate.tarball,
    '--tag', 'alpha', '--access', 'public', '--provenance', '--ignore-scripts', '--registry', registry],
    { stdio: 'inherit', timeout: 180_000, env: { ...process.env, NODE_AUTH_TOKEN: '', NPM_TOKEN: '' } });
  // A lost response may follow a successful publish. Check registry bytes before failing.
  if (child.error || child.status !== 0) console.warn('npm did not return success; checking registry before permitting a retry.');
} else console.log('The identical package is already published under alpha; skipping the registry write.');
await waitForPublication(context.version, candidate.integrity);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `### Published diffglow ${context.version}\n\nSHA-256: \`${candidate.sha256}\`\n\nRegistry integrity and alpha tag match. Fresh installation and GitHub prerelease follow.\n`);
