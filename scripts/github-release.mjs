import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, readCandidate, registryJSON, releaseContext, releaseChannel, repository, assertPublished } from './release-utils.mjs';

export async function resolveTag(tag, request) {
  let ref = await request(`/git/ref/tags/${encodeURIComponent(tag)}`, { missing: true });
  if (ref === null) return null;
  let object = ref.object;
  for (let depth = 0; depth < 5 && object?.type === 'tag'; depth++) object = (await request(`/git/tags/${object.sha}`)).object;
  assert.equal(object?.type, 'commit', 'Release tag must resolve to a commit.');
  return object.sha;
}
export function assertTag(tagSha, expectedSha) {
  if (tagSha !== null) assert.equal(tagSha, expectedSha, 'Release tag points at another commit; never retarget it.');
}
export function assertAsset(asset, sha256) {
  assert.equal(asset.digest, `sha256:${sha256}`, `Existing release asset ${asset.name} differs; refusing to overwrite it.`);
}
export function githubReleaseOptions(version) {
  const prerelease = releaseChannel(version) === 'alpha';
  return { draft: false, prerelease, make_latest: prerelease ? 'false' : 'true' };
}
export function assertRelease(release, version) {
  assert.equal(release.tag_name, `v${version}`);
  assert.equal(release.prerelease, githubReleaseOptions(version).prerelease, 'Existing release has a different prerelease status; refusing to change it.');
  assert.equal(release.draft, false, 'Existing release is a draft; refusing to publish it implicitly.');
}

export async function main() {
  const context = releaseContext();
  const candidate = await readCandidate(context);
  assertPublished(await registryJSON(`/${encodeURIComponent(context.version)}`), context.version, candidate.integrity);
  const tags = await registryJSON('/dist-tags'); assert.equal(tags?.[releaseChannel(context.version)], context.version);
  assert.ok(process.env.GH_TOKEN, 'The GitHub release job requires its scoped GitHub token.');
  async function request(route, { method = 'GET', body, missing = false } = {}) {
    const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
      method, signal: AbortSignal.timeout(30_000), headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {})
      }, ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (response.status === 404 && missing) return null;
    assert.ok(response.ok, `GitHub ${method} ${route} returned HTTP ${response.status}.`);
    return response.json();
  }
  const tag = `v${context.version}`;
  assertTag(await resolveTag(tag, request), context.sha);
  let release = await request(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });
  if (!release) {
    const changelog = await readFile('CHANGELOG.md', 'utf8');
    const heading = `## ${context.version}\n`;
    assert.ok(changelog.includes(heading), 'The released version needs a changelog entry.');
    const notes = changelog.split(heading)[1].split('\n## ')[0].trim();
    release = await request('/releases', { method: 'POST', body: {
      tag_name: tag, target_commitish: context.sha, name: `Diffglow ${context.version}`,
      body: `${notes}\n\nInstall: \`npx --yes diffglow@${context.version} --help\`\n\nVerified on Linux, macOS, and Windows with Node.js 22 and 24.`,
      ...githubReleaseOptions(context.version)
    } });
  }
  assertRelease(release, context.version);
  assert.equal(await resolveTag(tag, request), context.sha, 'Published release tag differs from the verified source.');
  const publicDirectory = path.join(context.directory, 'public-release');
  await mkdir(publicDirectory, { recursive: true });
  const sums = path.join(publicDirectory, 'SHA256SUMS');
  await writeFile(sums, `${candidate.sha256}  ${candidate.filename}\n`);
  const attachments = [
    [candidate.filename, candidate.tarball], ['SHA256SUMS', sums],
    ['demo.png', path.join(context.directory, 'screenshots/demo.png')],
    ['highlighted.png', path.join(context.directory, 'screenshots/highlighted.png')]
  ];
  for (const [name, filename] of attachments) {
    const expected = digest(await readFile(filename));
    const existing = release.assets.find(asset => asset.name === name);
    if (existing) { assertAsset(existing, expected); continue; }
    const upload = spawnSync('gh', ['release', 'upload', tag, `${filename}#${name}`, '--repo', repository],
      { encoding: 'utf8', timeout: 120_000, env: process.env });
    assert.equal(upload.error, undefined); assert.equal(upload.status, 0, upload.stderr);
    release = await request(`/releases/${release.id}`);
    const created = release.assets.find(asset => asset.name === name);
    assert.ok(created, 'Uploaded release asset was not returned by GitHub.'); assertAsset(created, expected);
  }
  const label = githubReleaseOptions(context.version).prerelease ? 'prerelease' : 'release';
  console.log(`GitHub ${label} verified: ${release.html_url}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `### GitHub ${label}\n\n[Diffglow ${context.version}](${release.html_url})\n\nSource commit: \`${context.sha}\`\n\nTag and release asset digests verified.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
