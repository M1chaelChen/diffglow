import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
// @ts-expect-error Internal release scripts deliberately have no published TypeScript API.
import { alphaParts, compareAlphas, releaseContext, readCandidate, registryJSON, assertPublished, publishDecision, waitForPublication } from '../scripts/release-utils.mjs';
// @ts-expect-error Internal release scripts deliberately have no published TypeScript API.
import { resolveTag, assertTag, assertAsset } from '../scripts/github-release.mjs';

const version = '0.1.0-alpha.3';
const sha = '0123456789abcdef0123456789abcdef01234567';
const bytes = Buffer.from('an immutable reviewed package candidate\n');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const published = { name: 'diffglow', version, dist: { integrity } };

function environment() {
  return {
    EXPECTED_VERSION: version, EXPECTED_SHA: sha,
    GITHUB_REPOSITORY: 'M1chaelChen/diffglow', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: sha,
    GITHUB_WORKFLOW_REF: 'M1chaelChen/diffglow/.github/workflows/release.yml@refs/heads/main'
  };
}

async function candidate(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'diffglow release candidate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = `diffglow-${version}.tgz`;
  await writeFile(path.join(directory, filename), bytes);
  await writeFile(path.join(directory, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
  await writeFile(path.join(directory, 'package-report.json'), JSON.stringify({ status: 'passed', sha256 }));
  await writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify({
    package: `diffglow@${version}`, sourceCommit: sha, sourceHasUncommittedChanges: false, status: 'passed-local-checks'
  }));
  return { directory, version, sha };
}

async function changeJSON(directory: string, filename: string, changes: Record<string, unknown>) {
  const file = path.join(directory, filename);
  const document = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...document, ...changes }));
}

test('release versions require explicit alpha numbers and compare numerically without precision loss', () => {
  assert.deepEqual(alphaParts(version), [0n, 1n, 0n, 3n]);
  for (const invalid of ['', 'latest', 'alpha', '0.1.0', 'v0.1.0-alpha.3', '0.1.0-beta.3', '0.1.0-alpha.03', '01.1.0-alpha.3', '0.1.0-alpha.3+build', '0.1.0-alpha.NaN', '0.1.0-alpha.1e3', '0.1.0-alpha.-1', '0.1.0-alpha.1.2']) {
    assert.throws(() => alphaParts(invalid), /explicit.*alpha/);
  }
  assert.equal(compareAlphas('0.1.0-alpha.10', '0.1.0-alpha.2'), 1);
  assert.equal(compareAlphas('0.2.0-alpha.1', '0.1.99-alpha.999'), 1);
  assert.equal(compareAlphas('0.1.0-alpha.2', version), -1);
  assert.equal(compareAlphas(version, version), 0);
  assert.equal(compareAlphas('0.1.0-alpha.9007199254740993', '0.1.0-alpha.9007199254740992'), 1);
});

test('release context binds the requested commit to main and the exact repository workflow', () => {
  const directory = path.join(tmpdir(), 'reviewed release with spaces');
  assert.deepEqual(releaseContext({ ...environment(), RELEASE_DIRECTORY: directory }), { version, sha, directory: path.resolve(directory) });
  for (const changes of [
    { EXPECTED_VERSION: '0.1.0' }, { EXPECTED_SHA: 'not-a-commit' },
    { GITHUB_REPOSITORY: 'somebody/diffglow' }, { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_SHA: 'f'.repeat(40) },
    { GITHUB_WORKFLOW_REF: 'M1chaelChen/diffglow/.github/workflows/other.yml@refs/heads/main' },
    { GITHUB_WORKFLOW_REF: 'M1chaelChen/diffglow/.github/workflows/release.yml@refs/heads/feature' }
  ]) assert.throws(() => releaseContext({ ...environment(), ...changes }));
});

test('a candidate yields exactly the reviewed bytes, SHA-256, and registry SHA-512 integrity', async t => {
  const context = await candidate(t);
  const result = await readCandidate(context);
  assert.deepEqual(result, {
    filename: `diffglow-${version}.tgz`, tarball: path.join(context.directory, `diffglow-${version}.tgz`), bytes, sha256, integrity
  });
});

test('candidate verification rejects modified bytes, checksums, reports, and source manifests', async t => {
  const cases: Array<[string, (directory: string) => Promise<unknown>]> = [
    ['modified tarball', directory => writeFile(path.join(directory, `diffglow-${version}.tgz`), 'replacement bytes')],
    ['incorrect checksum', directory => writeFile(path.join(directory, 'SHA256SUMS'), `${'0'.repeat(64)}  diffglow-${version}.tgz\n`)],
    ['duplicate checksum', directory => writeFile(path.join(directory, 'SHA256SUMS'), `${sha256}  diffglow-${version}.tgz\n`.repeat(2))],
    ['missing checksum', directory => writeFile(path.join(directory, 'SHA256SUMS'), `${sha256}  somebody-else.tgz\n`)],
    ['report digest mismatch', directory => changeJSON(directory, 'package-report.json', { sha256: '0'.repeat(64) })],
    ['failed package validation', directory => changeJSON(directory, 'package-report.json', { status: 'failed' })],
    ['different package version', directory => changeJSON(directory, 'release-manifest.json', { package: 'diffglow@0.1.0-alpha.2' })],
    ['different source commit', directory => changeJSON(directory, 'release-manifest.json', { sourceCommit: 'f'.repeat(40) })],
    ['dirty source', directory => changeJSON(directory, 'release-manifest.json', { sourceHasUncommittedChanges: true })],
    ['unverified source', directory => changeJSON(directory, 'release-manifest.json', { status: 'pending' })],
    ['missing report', directory => rm(path.join(directory, 'package-report.json'))]
  ];
  for (const [name, mutate] of cases) await t.test(name, async subtest => {
    const context = await candidate(subtest);
    await mutate(context.directory);
    await assert.rejects(readCandidate(context));
  });
});

test('an immutable published version is reusable only when its name, version, and bytes match', () => {
  assert.doesNotThrow(() => assertPublished(published, version, integrity));
  for (const metadata of [null, { ...published, name: 'another-package' }, { ...published, version: '0.1.0-alpha.2' }, { ...published, dist: { integrity: 'sha512-different' } }, { ...published, dist: {} }]) {
    assert.throws(() => assertPublished(metadata, version, integrity));
  }
  assert.equal(publishDecision(published, { alpha: version }, version, integrity), false);
  assert.throws(() => publishDecision({ ...published, dist: { integrity: 'sha512-different' } }, { alpha: version }, version, integrity), /different bytes/);
  assert.throws(() => publishDecision(published, { alpha: '0.1.0-alpha.4' }, version, integrity), /alpha points elsewhere/);
  assert.throws(() => publishDecision(published, {}, version, integrity), /alpha points elsewhere/);
});

test('a new version advances alpha and refuses rollback or an ambiguous channel', () => {
  assert.equal(publishDecision(null, {}, version, integrity), true);
  assert.equal(publishDecision(null, { alpha: '0.1.0-alpha.2' }, version, integrity), true);
  for (const alpha of [version, '0.1.0-alpha.10', '0.2.0-alpha.1']) {
    assert.throws(() => publishDecision(null, { alpha }, version, integrity), /older alpha|backward/);
  }
  assert.throws(() => publishDecision(null, { alpha: '0.1.0' }, version, integrity), /explicit.*alpha/);
});

test('registry reads retry network failures, throttling, and server errors with bounded backoff', async () => {
  const waits: number[] = []; const requests: Array<{ url: string; options: RequestInit }> = [];
  let count = 0;
  const result = await registryJSON(`/${version}`, {
    fetcher: async (url: string, options: RequestInit) => {
      requests.push({ url, options });
      count++;
      if (count === 1) throw new Error('connection reset');
      if (count === 2) return new Response('rate limited', { status: 429 });
      if (count === 3) return new Response('unavailable', { status: 503 });
      return Response.json(published);
    },
    wait: async (milliseconds: number) => { waits.push(milliseconds); }
  });
  assert.deepEqual(result, published); assert.equal(count, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  for (const request of requests) {
    assert.equal(request.url, `https://registry.npmjs.org/diffglow/${version}`);
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.equal(new Headers(request.options.headers).get('Cache-Control'), 'no-cache');
  }
});

test('a registry 404 means absent while authentication errors fail immediately', async () => {
  assert.equal(await registryJSON(`/${version}`, {
    fetcher: async () => new Response('not found', { status: 404 }),
    wait: async () => assert.fail('404 must not wait')
  }), null);
  for (const status of [400, 401, 403]) {
    let count = 0;
    await assert.rejects(registryJSON(`/${version}`, {
      fetcher: async () => { count++; return new Response('denied', { status }); },
      wait: async () => assert.fail('authorization errors must not retry')
    }), new RegExp(`HTTP ${status}`));
    assert.equal(count, 1);
  }
});

test('registry metadata and dist-tags use their distinct npm API endpoints', async () => {
  const requests: string[] = [];
  const options = {
    fetcher: async (url: string) => {
      requests.push(url);
      if (url === `https://registry.npmjs.org/diffglow/${version}`) return Response.json(published);
      if (url === 'https://registry.npmjs.org/-/package/diffglow/dist-tags') return Response.json({ alpha: version });
      assert.fail(`Unexpected registry endpoint: ${url}`);
    },
    wait: async () => assert.fail('successful metadata lookups must not retry')
  };
  assert.deepEqual(await registryJSON(`/${version}`, options), published);
  assert.deepEqual(await registryJSON('/dist-tags', options), { alpha: version });
  assert.deepEqual(requests, [
    `https://registry.npmjs.org/diffglow/${version}`,
    'https://registry.npmjs.org/-/package/diffglow/dist-tags'
  ]);
});

test('exhausted registry retries never become an absent version or permission to publish', async () => {
  let count = 0; const waits: number[] = [];
  await assert.rejects(registryJSON(`/${version}`, {
    attempts: 3,
    fetcher: async () => { count++; return new Response('unavailable', { status: 503 }); },
    wait: async (milliseconds: number) => { waits.push(milliseconds); }
  }), /HTTP 503/);
  assert.equal(count, 3); assert.deepEqual(waits, [1000, 2000]);
  const offline = new Error('offline'); count = 0;
  await assert.rejects(registryJSON(`/${version}`, {
    attempts: 2, fetcher: async () => { count++; throw offline; }, wait: async () => {}
  }), error => error === offline);
  assert.equal(count, 2);
});

test('publication waits until both immutable bytes and the alpha channel are visible', async () => {
  const answers = [null, published, { alpha: '0.1.0-alpha.2' }, published, { alpha: version }];
  const suffixes: string[] = []; const waits: number[] = [];
  const result = await waitForPublication(version, integrity, {
    get: async (suffix: string) => { suffixes.push(suffix); return answers.shift(); },
    wait: async (milliseconds: number) => { waits.push(milliseconds); }, attempts: 3
  });
  assert.deepEqual(result, published); assert.equal(answers.length, 0);
  assert.deepEqual(suffixes, [`/${version}`, `/${version}`, '/dist-tags', `/${version}`, '/dist-tags']);
  assert.deepEqual(waits, [2000, 2000]);
});

test('publication fails immediately on different bytes or a newer alpha instead of moving tags', async () => {
  await assert.rejects(waitForPublication(version, integrity, {
    get: async () => ({ ...published, dist: { integrity: 'sha512-different' } }),
    wait: async () => assert.fail('mismatched immutable bytes must not retry')
  }), /different bytes/);
  await assert.rejects(waitForPublication(version, integrity, {
    get: async (suffix: string) => suffix === '/dist-tags' ? { alpha: '0.1.0-alpha.4' } : published,
    wait: async () => assert.fail('newer alpha must not retry')
  }), /newer alpha/);
});

test('publication times out with recovery guidance and propagates registry failures', async () => {
  let reads = 0; let waits = 0;
  await assert.rejects(waitForPublication(version, integrity, {
    get: async () => { reads++; return null; },
    wait: async () => { waits++; }, attempts: 3
  }), /inspect npm before rerunning/);
  assert.equal(reads, 3); assert.equal(waits, 2);
  const denied = new Error('npm registry returned HTTP 403');
  await assert.rejects(waitForPublication(version, integrity, {
    get: async () => { throw denied; }, wait: async () => assert.fail('read failures must not be hidden')
  }), error => error === denied);
});

test('GitHub tag lookup resolves lightweight and annotated tags without changing either', async () => {
  assert.equal(await resolveTag(`v${version}`, async (route: string, options: { missing?: boolean }) => {
    assert.equal(route, `/git/ref/tags/v${version}`); assert.equal(options.missing, true);
    return null;
  }), null);
  assert.equal(await resolveTag(`v${version}`, async () => ({ object: { type: 'commit', sha } })), sha);
  const requests: string[] = [];
  assert.equal(await resolveTag(`v${version}`, async (route: string) => {
    requests.push(route);
    if (route.startsWith('/git/ref/')) return { object: { type: 'tag', sha: 'a'.repeat(40) } };
    if (route.endsWith('a'.repeat(40))) return { object: { type: 'tag', sha: 'b'.repeat(40) } };
    return { object: { type: 'commit', sha } };
  }), sha);
  assert.deepEqual(requests, [`/git/ref/tags/v${version}`, `/git/tags/${'a'.repeat(40)}`, `/git/tags/${'b'.repeat(40)}`]);
});

test('GitHub tag resolution rejects non-commit targets and excessive annotation nesting', async () => {
  await assert.rejects(resolveTag(`v${version}`, async () => ({ object: { type: 'blob', sha } })), /must resolve to a commit/);
  let requests = 0;
  await assert.rejects(resolveTag(`v${version}`, async () => {
    requests++; return { object: { type: 'tag', sha } };
  }), /must resolve to a commit/);
  assert.equal(requests, 6);
  assert.doesNotThrow(() => assertTag(null, sha));
  assert.doesNotThrow(() => assertTag(sha, sha));
  assert.throws(() => assertTag('f'.repeat(40), sha), /never retarget/);
});

test('GitHub release retries reuse matching assets and reject unknown or different bytes', () => {
  assert.doesNotThrow(() => assertAsset({ name: 'package.tgz', digest: `sha256:${sha256}` }, sha256));
  assert.throws(() => assertAsset({ name: 'package.tgz', digest: `sha256:${'0'.repeat(64)}` }, sha256), /refusing to overwrite/);
  assert.throws(() => assertAsset({ name: 'package.tgz' }, sha256), /refusing to overwrite/);
});
