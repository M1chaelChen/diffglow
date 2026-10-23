import assert from 'node:assert/strict';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { portablePath, relativeError } from '../src/paths.js';
import { workspace } from './helpers.js';

const posixUser = (...parts: string[]) => ['', 'Users', ...parts].join('/');
const windowsUser = (drive: string, ...parts: string[]) => [drive, 'Users', ...parts].join('\\');

test('portable paths retain safe descendants and shorten external POSIX paths without parent traversal', () => {
  const base = posixUser('private-user', 'project');
  assert.equal(portablePath(`${base}/baseline/nested/screen shot.png`, base), 'baseline/nested/screen shot.png');
  assert.equal(portablePath('current/screen.png', base), 'current/screen.png');
  assert.equal(portablePath(base, base), '.');
  assert.equal(portablePath(posixUser('other-private-user', 'screens', 'screen.png'), base), 'screen.png');
  assert.equal(portablePath('../../other-private-user/screens/screen.png', base), 'screen.png');
  assert.equal(portablePath(posixUser('private-user', 'project-copy', 'screen.png'), base), 'screen.png');
});

test('portable paths handle Windows drives, case-insensitive descendants, UNC shares, and cross-platform inputs', () => {
  const base = windowsUser('C:', 'private-user', 'project');
  const insensitive = ['c:', 'users', 'PRIVATE-USER', 'project', 'baseline', 'screen shot.png'].join('\\');
  assert.equal(portablePath(insensitive, base), 'baseline/screen shot.png');
  assert.equal(portablePath('current\\screen.png', base), 'current/screen.png');
  assert.equal(portablePath(windowsUser('D:', 'another-user', 'screen.png'), base), 'screen.png');
  assert.equal(portablePath('D:screen.png', base), 'screen.png');
  assert.equal(portablePath('D:\\', base), '[external]');
  assert.equal(portablePath('D:', base), '[external]');
  assert.equal(portablePath(windowsUser('C:', 'other-user', 'screen.png'), base), 'screen.png');
  assert.equal(portablePath('\\\\server\\private-share\\screen.png', base), 'screen.png');
  assert.equal(portablePath('\\\\server\\private-share\\', base), '[external]');
  assert.equal(portablePath('\\\\server\\share\\project\\current\\screen.png', '\\\\server\\share\\project'), 'current/screen.png');
  assert.equal(portablePath(windowsUser('C:', 'private-user', 'screen.png'), '/project'), 'screen.png');
  assert.equal(portablePath(posixUser('private-user', 'screen.png'), base), 'screen.png');
});

test('relative errors replace repeated known paths and canonical aliases while retaining failure reasons', async t => {
  const directory = await realpath(await workspace(t));
  const inputs = path.join(directory, 'screens with spaces');
  await mkdir(inputs);
  const file = path.join(inputs, 'before.png');
  await writeFile(file, 'not an image');
  const message = `Cannot decode "${file}" as a screenshot: Input file ${file} contains unsupported image format`;
  const sanitized = relativeError(message, [file], directory);
  assert.equal(sanitized, 'Cannot decode "screens with spaces/before.png" as a screenshot: Input file screens with spaces/before.png contains unsupported image format');
  assert.doesNotMatch(sanitized, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('relative errors shorten external, Windows, normalized, JSON-escaped, and parent-relative path aliases', () => {
  const source = windowsUser('C:', 'private-user', 'private shots', 'before.png');
  const variants = [source, source.replaceAll('\\', '/'), JSON.stringify(source).slice(1, -1)];
  for (const value of variants) {
    const message = relativeError(`Cannot read input "${value}": ENOENT, open '${value}'`, [source], 'C:\\project');
    assert.equal(message, 'Cannot read input "before.png": ENOENT, open \'before.png\'');
    assert.doesNotMatch(message, /private-user|private shots|C:/);
  }
  assert.equal(relativeError('Missing "../../private-user/before.png"', ['../../private-user/before.png'], '/project/work'), 'Missing "before.png"');
});

test('unregistered native paths fail closed without repeating usernames, path tails, or temporary paths', () => {
  const missing = posixUser('private-user', 'private shots', 'before.png');
  const linux = ['', 'home', 'private-user', 'report with spaces', '.diffglow-stage-secret'].join('/');
  const output = windowsUser('C:', 'private-user', 'report', 'diff.png');
  const temporary = windowsUser('C:', 'private-user', 'temporary');
  const parent = ['..', '..', 'Users', 'private-user', 'screens', 'before.png'].join('/');
  const cases = [
    `Cannot read input "${missing}": ENOENT: open '${missing}'`,
    `EACCES: permission denied, mkdir '${linux}'`,
    `Cannot write output "${output}": rename '${temporary}'`,
    `Could not open \\\\private-user-server\\private-share\\screen.png`,
    `Could not open file://${posixUser('private-user', 'screens', 'screen.png')}`,
    `Cannot read input '${parent}': ENOENT`,
    `Cannot decode '${posixUser("O'PrivateUser", 'screens', 'image.png')}': Input file contains unsupported image format`
  ];
  for (const original of cases) {
    const sanitized = relativeError(original, [], '/project');
    assert.match(sanitized, /\[local path\]/);
    assert.doesNotMatch(sanitized, /private-user|PrivateUser|private-share|diffglow-stage|Users|C:|file:\/\/|\.\.[\\/]/);
    if (original.includes('ENOENT')) assert.match(sanitized, /ENOENT/);
  }
});

test('unregistered temporary paths under home fail closed after known output paths are shortened', () => {
  // Windows keeps its native temporary directory under home. Use the actual
  // host home so this privacy regression also runs on Linux and macOS.
  const privateRoot = path.join(homedir(), 'AppData', 'Local', 'Temp', 'PRIVATE_REPORT_OWNER_8675309', 'screenshots with spaces');
  const output = path.join(privateRoot, 'output.png');
  const temporary = path.join(privateRoot, '.diffglow-private-stage.tmp');
  const base = path.join(path.parse(homedir()).root, 'consumer');
  const original = `Cannot write output "${output}": EPERM: operation not permitted, rename '${temporary}' -> '${output}'`;
  const sanitized = relativeError(original, [output], base);
  assert.equal(sanitized, 'Cannot write output "output.png": EPERM: operation not permitted, rename [local path].');
  assert.doesNotMatch(sanitized, /PRIVATE_REPORT_OWNER|AppData|diffglow-private-stage|\[home\]/);
});

test('safe diagnostics, URLs, portable labels, and similarly named files remain intact', () => {
  const cases = [
    'Threshold must be a finite number between 0 and 1.',
    'Cannot decode "baseline/screen.png": unsupported image format',
    'See https://example.com/docs/errors for details.',
    'Unable to read ./screens/before.png',
    'No PNG/JPEG screenshots matched the configured folders and patterns.'
  ];
  for (const message of cases) assert.equal(relativeError(message, [], '/project'), message);
  assert.equal(relativeError('Missing "/project-copy/screen.png"', [], '/project'), 'Missing [local path].');
  assert.equal(relativeError('Missing "/project/screen.png.backup"', ['/project/screen.png'], '/project'), 'Missing "./screen.png.backup"');
});

test('colon-adjacent unknown native paths are removed without treating HTTPS separators as local paths', () => {
  const paths = [
    posixUser('private-user', 'screens', 'image.png'),
    windowsUser('C:', 'private-user', 'screens', 'image.png'),
    '\\\\private-user-server\\private-share\\image.png'
  ];
  for (const filename of paths) {
    const sanitized = relativeError(`Native load failed:path:${filename}`, [], '/project');
    assert.equal(sanitized, 'Native load failed:path [local path].');
    assert.doesNotMatch(sanitized, /private-user|private-share|Users|C:/);
  }
  const diagnostic = 'Native load failed; see https://example.com/docs/errors?code=ENOENT';
  assert.equal(relativeError(diagnostic, [], '/project'), diagnostic);
});

test('canonical symlink targets receive the requested portable label', async t => {
  const directory = await realpath(await workspace(t));
  const base = path.join(directory, 'project');
  const external = path.join(directory, 'private-user');
  await mkdir(base); await mkdir(external);
  const source = path.join(external, 'screen.png');
  await writeFile(source, 'not an image');
  const alias = path.join(base, 'input.png');
  try { await symlink(source, alias, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) {
      t.skip('Windows symlink privileges unavailable.'); return;
    }
    throw error;
  }
  assert.equal(relativeError(`Cannot decode "${source}": unsupported image format`, [alias], base), 'Cannot decode "input.png": unsupported image format');
});
