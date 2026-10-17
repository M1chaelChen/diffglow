import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const excluded = new Set(['.git', 'node_modules', 'research', 'artifacts', 'dist', '.DS_Store']);
const forbidden = /(?:^|\/)(?:research|node_modules|artifacts|dist|\.env(?:\.[^/]*)?|\.npmrc|\.DS_Store)(?:\/|$)|\.(?:pem|key|tgz|log)$/i;
const secretPatterns = [
  /npm_[A-Za-z0-9]{30,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-proj-[A-Za-z0-9_-]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];
const personalPathPatterns = [/\/(?:Users|home)\/[^/\s]+\//, /[A-Za-z]:\\Users\\[^\\\s]+\\/, /\/(?:private\/)?var\/folders\//];
async function walk(directory = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const filename = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await walk(filename));
    else result.push(filename);
  }
  return result;
}

const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
const filenames = [...new Set(git.status === 0 ? git.stdout.split('\0').filter(Boolean) : await walk())].sort();
assert.ok(filenames.length > 0, 'No public files found to audit.');
const issues = [];
function inspect(filename, bytes, source) {
  if (bytes.includes(0)) return; // Binary fixtures are inspected visually, not as text.
  const text = bytes.toString('utf8');
  if (secretPatterns.some(pattern => pattern.test(text))) issues.push(`Potential credential in ${source}: ${filename}`);
  if (personalPathPatterns.some(pattern => pattern.test(text))) issues.push(`Personal absolute path in ${source}: ${filename}`);
}
for (const filename of filenames) {
  if (forbidden.test(filename)) { issues.push(`Disallowed public path: ${filename}`); continue; }
  const absolute = path.join(root, filename);
  let info;
  try { info = await lstat(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    issues.push(`Missing working-tree file still listed in Git: ${filename}`);
    continue;
  }
  if (!info.isFile()) { issues.push(`Unexpected public entry: ${filename}`); continue; }
  inspect(filename, await readFile(absolute), 'working tree');
}
const stagedFiles = [];
if (git.status === 0) {
  const index = spawnSync('git', ['ls-files', '--stage', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(index.status, 0, 'Could not inspect the Git index.');
  for (const entry of index.stdout.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
    assert.ok(match, 'Unexpected Git index entry.');
    const [, mode, object, stage, filename] = match;
    stagedFiles.push(filename);
    if (stage !== '0') { issues.push(`Unmerged Git index entry: ${filename}`); continue; }
    if (forbidden.test(filename)) { issues.push(`Disallowed staged path: ${filename}`); continue; }
    if (!['100644', '100755'].includes(mode)) { issues.push(`Unexpected staged file mode ${mode}: ${filename}`); continue; }
    const blob = spawnSync('git', ['cat-file', 'blob', object], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(blob.status, 0, `Could not read staged content: ${filename}`);
    inspect(filename, blob.stdout, 'staged content');
  }
}
const report = {
  status: issues.length ? 'failed' : 'passed', checkedAt: new Date().toISOString(),
  source: git.status === 0 ? 'Git index and non-ignored working-tree files' : 'Public working-tree candidates; Git has not been initialized',
  checkedFiles: filenames, checkedStagedFiles: stagedFiles, issues,
  limitations: ['Pattern checks are not a full secret scanner.', 'Binary screenshots require visual review.', 'This audit inspects current public files, not prior Git history.']
};
const releaseDir = path.join(root, 'artifacts', 'release', manifest.version);
await mkdir(releaseDir, { recursive: true });
await writeFile(path.join(releaseDir, 'public-audit.json'), JSON.stringify(report, null, 2) + '\n');
assert.deepEqual(issues, [], `Public file audit failed:\n${issues.join('\n')}`);
console.log(`Public file audit: ${filenames.length} files passed (${report.source}).`);
