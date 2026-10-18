import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const registry = 'https://registry.npmjs.org';
export const repository = 'M1chaelChen/diffglow';
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');

export function alphaParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.exec(version ?? '');
  assert.ok(match, 'An explicit x.y.z-alpha.n version is required.');
  return match.slice(1).map(BigInt);
}
export function compareAlphas(left, right) {
  const a = alphaParts(left), b = alphaParts(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function releaseContext(env = process.env) {
  alphaParts(env.EXPECTED_VERSION);
  assert.match(env.EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_SHA, env.EXPECTED_SHA);
  assert.equal(env.GITHUB_WORKFLOW_REF, `${repository}/.github/workflows/release.yml@refs/heads/main`);
  return { version: env.EXPECTED_VERSION, sha: env.EXPECTED_SHA,
    directory: path.resolve(env.RELEASE_DIRECTORY ?? `artifacts/release/${env.EXPECTED_VERSION}`) };
}
export async function readCandidate({ directory, version, sha }) {
  alphaParts(version);
  const filename = `diffglow-${version}.tgz`;
  const tarball = path.join(directory, filename);
  const bytes = await readFile(tarball);
  const sha256 = digest(bytes);
  const sums = (await readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/)
    .map(line => /^([a-f0-9]{64}) [ *](.+)$/.exec(line)).filter(entry => entry?.[2] === filename);
  assert.equal(sums.length, 1, 'Candidate must have exactly one tarball checksum.');
  assert.equal(sums[0][1], sha256, 'Candidate checksum differs.');
  const report = JSON.parse(await readFile(path.join(directory, 'package-report.json'), 'utf8'));
  assert.equal(report.status, 'passed'); assert.equal(report.sha256, sha256);
  const manifest = JSON.parse(await readFile(path.join(directory, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.package, `diffglow@${version}`);
  assert.equal(manifest.sourceCommit, sha); assert.equal(manifest.sourceHasUncommittedChanges, false);
  assert.equal(manifest.status, 'passed-local-checks');
  return { filename, tarball, bytes, sha256, integrity: `sha512-${digest(bytes, 'sha512')}` };
}
export async function registryJSON(suffix, { fetcher = fetch, wait = sleep, attempts = 4 } = {}) {
  const url = suffix === '/dist-tags' ? `${registry}/-/package/diffglow/dist-tags` : `${registry}/diffglow${suffix}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try { response = await fetcher(url, { signal: AbortSignal.timeout(30_000), headers: { 'Cache-Control': 'no-cache' } }); }
    catch (error) { if (attempt + 1 === attempts) throw error; await wait(1000 * 2 ** attempt); continue; }
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) { await wait(1000 * 2 ** attempt); continue; }
    throw new Error(`npm registry returned HTTP ${response.status}; refusing to publish.`);
  }
}
export function assertPublished(metadata, version, integrity) {
  assert.equal(metadata?.name, 'diffglow'); assert.equal(metadata?.version, version);
  assert.equal(metadata?.dist?.integrity, integrity, 'Registry contains different bytes; use a new alpha version.');
}
export function publishDecision(metadata, tags, version, integrity) {
  if (metadata !== null) {
    assertPublished(metadata, version, integrity);
    assert.equal(tags?.alpha, version, 'This version exists but alpha points elsewhere; refusing to move the channel.');
    return false;
  }
  if (tags?.alpha) assert.ok(compareAlphas(version, tags.alpha) > 0, 'Refusing to publish an older alpha or move alpha backward.');
  return true;
}
export async function waitForPublication(version, integrity, { get = registryJSON, wait = sleep, attempts = 30 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const metadata = await get(`/${encodeURIComponent(version)}`);
    if (metadata) {
      assertPublished(metadata, version, integrity);
      const tags = await get('/dist-tags');
      if (tags?.alpha === version) return metadata;
      if (tags?.alpha && compareAlphas(tags.alpha, version) > 0) throw new Error('A newer alpha is already current.');
    }
    if (attempt + 1 < attempts) await wait(2000);
  }
  throw new Error('Publication not visible with matching integrity and alpha tag; inspect npm before rerunning failed jobs.');
}
