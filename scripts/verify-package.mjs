import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, link, mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'artifacts', 'release', manifest.version);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this check through npm run verify:package.');
const consumerMode = process.argv[2] === '--consumer-check';
if (!consumerMode) await mkdir(releaseDir, { recursive: true });
const checks = [];
const report = {
  package: `${manifest.name}@${manifest.version}`,
  platform: process.platform, architecture: process.arch, node: process.version,
  startedAt: new Date().toISOString(), status: 'running', checks,
  scope: 'This report verifies only the platform and Node.js version named above; the CI matrix verifies other environments.'
};
let consumer;
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_PATH;
delete cleanEnv.NODE_OPTIONS;
const pathKey = Object.keys(cleanEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
cleanEnv[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${cleanEnv[pathKey] || ''}`;
// Keep verification self-contained and avoid modifying a developer's global npm cache.
cleanEnv.npm_config_cache = path.join(root, 'artifacts', '.npm-cache');

function command(executable, args, cwd, expected = 0, timeout = 180_000) {
  const result = spawnSync(executable, args, {
    cwd, env: cleanEnv, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    windowsVerbatimArguments: process.platform === 'win32' && /(?:^|[\\/])cmd\.exe$/i.test(executable)
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, expected,
    `${path.basename(executable)} exited ${result.status}; expected ${expected}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function npm(args, cwd = root) {
  return command(process.execPath, [npmCli, ...args], cwd);
}

async function check(name, operation) {
  await operation();
  checks.push({ name, status: 'passed' });
  console.log(`Packed CLI: ${name} — passed`);
}

function archiveFiles(tgz) {
  const tar = gunzipSync(tgz);
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, size) => header.subarray(start, start + size).toString('utf8').replace(/\0.*$/s, '');
    const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(string(124, 12).trim(), 8) || 0;
    const type = string(156, 1);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= tar.length, 'Invalid tar entry.');
    if (type !== '5') {
      assert.ok(type === '' || type === '0', `Unexpected tar entry type ${type} for ${name}.`);
      assert.ok(name.startsWith('package/') && !name.split('/').includes('..'), `Unsafe tar path: ${name}`);
      const filename = name.slice('package/'.length);
      assert.ok(!files.has(filename), `Duplicate tar path: ${filename}`);
      files.set(filename, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function inspectText(filename, content) {
  if (!/\.(?:js|json|md|txt|map)$/.test(filename) && !/^(?:LICENSE|NOTICE)$/.test(filename)) return;
  const text = content.toString('utf8');
  const patterns = [
    /\/(?:Users|home)\/[^/\s]+\//,
    /[A-Za-z]:\\Users\\[^\\\s]+\\/,
    /\/(?:private\/)?var\/folders\//,
    /npm_[A-Za-z0-9]{30,}/,
    /gh[pousr]_[A-Za-z0-9]{30,}/,
    /github_pat_[A-Za-z0-9_]{30,}/,
    /sk-proj-[A-Za-z0-9_-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  ];
  for (const pattern of patterns) assert.ok(!pattern.test(text), `Unexpected sensitive content in packed ${filename}.`);
}

try {
  if (!consumerMode) {
  let metadata;
  if (process.env.DIFFGLOW_TARBALL) {
    const supplied = path.resolve(process.env.DIFFGLOW_TARBALL);
    const filename = `diffglow-${manifest.version}.tgz`;
    const target = path.join(releaseDir, filename);
    if (supplied !== target) await copyFile(supplied, target);
    metadata = { name: 'diffglow', version: manifest.version, filename };
    report.artifactSource = 'Existing tarball supplied through DIFFGLOW_TARBALL; package was not rebuilt.';
  } else {
    const packed = npm(['pack', '--json', '--pack-destination', releaseDir]);
    // npm may print prepack lifecycle output before its JSON result.
    const jsonStart = packed.stdout.search(/^[{[]/m);
    assert.ok(jsonStart >= 0, 'npm pack did not return its file manifest.');
    const packResult = JSON.parse(packed.stdout.slice(jsonStart));
    // npm 11 returns an array; npm 12 returns an object keyed by package name.
    metadata = Array.isArray(packResult) ? packResult[0] : packResult[manifest.name];
    assert.ok(metadata, 'npm pack returned no metadata for this package.');
    report.artifactSource = 'npm pack with normal prepack lifecycle.';
  }
  assert.equal(metadata.name, 'diffglow');
  assert.equal(metadata.version, manifest.version);
  const tarball = path.join(releaseDir, metadata.filename);
  const tarballBytes = await readFile(tarball);
  const files = archiveFiles(tarballBytes);
  const inventory = [...files].map(([filename, content]) => ({ path: filename, bytes: content.length })).sort((a, b) => a.path.localeCompare(b.path));
  report.tarball = metadata.filename;
  report.sha256 = createHash('sha256').update(tarballBytes).digest('hex');
  report.files = inventory;
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), `${report.sha256}  ${metadata.filename}\n`);
  await writeFile(path.join(releaseDir, 'package-files.json'), JSON.stringify(inventory, null, 2) + '\n');
  await check('tarball allowlist, licensing, metadata, and executable', async () => {
    if (metadata.files) assert.deepEqual(inventory.map(file => file.path).sort(), metadata.files.map(file => file.path).sort());
    const allowed = /^(?:package\.json|README\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md|dist\/[A-Za-z0-9_.-]+\.js|licenses\/[A-Za-z0-9_./-]+|docs\/demo\.png)$/;
    for (const [filename, content] of files) {
      assert.match(filename, allowed, `Unintended packed file: ${filename}`);
      inspectText(filename, content);
    }
    for (const required of ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/cli.js', 'dist/diff.js', 'docs/demo.png']) {
      assert.ok(files.has(required), `Missing packed release file: ${required}`);
    }
    for (const match of files.get('README.md').toString().matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      assert.ok(files.has(decodeURIComponent(target.split('#')[0].replace(/^\.\//, ''))),
        `README links to a file excluded from npm: ${target}`);
    }
    assert.ok([...files.keys()].some(file => file.startsWith('licenses/')), 'Dependency license texts must be included.');
    const pkg = JSON.parse(files.get('package.json').toString());
    assert.equal(pkg.name, manifest.name);
    assert.equal(pkg.version, manifest.version);
    assert.equal(pkg.private, undefined);
    assert.equal(pkg.license, 'Apache-2.0');
    assert.deepEqual(pkg.bin, { diffglow: 'dist/cli.js' });
    assert.deepEqual(pkg.exports, {}, 'The alpha exposes only its CLI, without library imports.');
    assert.ok(files.get('dist/cli.js').toString().startsWith('#!/usr/bin/env node\n'));
  });

  consumer = await mkdtemp(path.join(tmpdir(), 'diffglow packed consumer '));
  consumer = await realpath(consumer);
  const actualRoot = await realpath(root);
  const relativeConsumer = path.relative(actualRoot, await realpath(consumer));
  assert.ok(relativeConsumer.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConsumer),
    'The package consumer must be outside the source checkout.');
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'diffglow-clean-consumer', private: true }));
  await check('production-only installation outside the source checkout', async () => {
    npm(['install', '--omit=dev', '--no-audit', '--no-fund', '--package-lock=false',
      '--fetch-retries=0', '--fetch-timeout=30000', tarball], consumer);
    for (const name of ['tsx', 'typescript', '@types/node']) {
      await assert.rejects(access(path.join(consumer, 'node_modules', name)), { code: 'ENOENT' });
    }
  });
  // Native modules retain DLL handles on Windows until their process exits.
  // Keep all consumer Sharp work in a child so cleanup never removes a loaded DLL.
  const resultFile = path.join(consumer, 'consumer-checks.json');
  const child = command(process.execPath, [fileURLToPath(import.meta.url), '--consumer-check', consumer, resultFile], root, 0, 120_000);
  const childReport = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(childReport.status, 'passed', 'Installed-package child verification did not pass.');
  checks.push(...childReport.checks);
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  report.status = 'passed';
  } else {
  assert.equal(process.argv.length, 5, 'Consumer check mode requires a directory and result file.');
  consumer = await realpath(process.argv[3]);
  const installed = path.join(consumer, 'node_modules', 'diffglow');
  const requireInstalled = createRequire(path.join(installed, 'package.json'));
  const sharpRelative = path.relative(consumer, await realpath(requireInstalled.resolve('sharp')));
  assert.ok(sharpRelative !== '' && !sharpRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(sharpRelative),
    'Sharp must resolve from the clean consumer installation.');
  const sharp = requireInstalled('sharp');
  const cli = path.join(consumer, 'node_modules', '.bin', process.platform === 'win32' ? 'diffglow.cmd' : 'diffglow');
  const inputDir = path.join(consumer, 'screenshots with spaces');
  await mkdir(inputDir);
  function run(args, expected = 0) {
    if (process.platform === 'win32') {
      // npm generates a cmd shim on Windows. All arguments are controlled fixture paths/options.
      assert.ok([cli, ...args].every(arg => !/["%\r\n]/.test(arg)), 'Unsafe cmd fixture argument.');
      const quoted = [cli, ...args].map(arg => `"${arg}"`).join(' ');
      return command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], inputDir, expected);
    }
    return command(cli, args, inputDir, expected);
  }
  const pixels = (width, height, color = [255, 255, 255, 255]) => {
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(color, i);
    return data;
  };
  async function image(name, width, height, data = pixels(width, height)) {
    const filename = path.join(inputDir, name);
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(filename);
    return filename;
  }
  const readPixels = filename => sharp(filename).ensureAlpha().raw().toBuffer();
  const before = await image('before image.png', 8, 6);
  const data = pixels(8, 6);
  for (let y = 2; y < 4; y++) for (let x = 3; x < 5; x++) data.set([0, 100, 200, 255], (y * 8 + x) * 4);
  const after = await image('after image.png', 8, 6, data);
  await check('installed command help and version', async () => {
    assert.match(run(['--help']).stdout, /Usage: diffglow/);
    assert.equal(run(['--version']).stdout.trim(), manifest.version);
  });
  await check('identical images and default output preserve all pixels', async () => {
    assert.match(run([before, before, '--fail-on-diff']).stdout, /0 changed pixels \(0%\)/);
    assert.deepEqual(await readPixels(path.join(inputDir, 'diff.png')), await readPixels(before));
  });
  await check('known rectangle, surrounding colors, paths with spaces, and exit 1 after output', async () => {
    const output = path.join(inputDir, 'nested directory', 'highlighted image.png');
    const result = run([before, after, '--output', output, '--fail-on-diff'], 1);
    assert.match(result.stdout, /4 changed pixels \(8\.333333%\)/);
    const highlighted = await readPixels(output);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
      const offset = (y * 8 + x) * 4;
      assert.deepEqual([...highlighted.subarray(offset, offset + 4)],
        x >= 3 && x < 5 && y >= 2 && y < 4 ? [166, 35, 236, 255] : [255, 255, 255, 255]);
    }
    assert.match(run([before, after, '--output', output]).stdout, /4 changed pixels/);
  });
  await check('added and removed areas at threshold 1', async () => {
    const small = await image('small.png', 2, 3);
    const large = await image('large.png', 4, 3);
    for (const [first, second, filename] of [[small, large, 'added.png'], [large, small, 'removed.png']]) {
      const output = path.join(inputDir, filename);
      assert.match(run([first, second, '-o', output, '--threshold', '1']).stdout, /6 changed pixels \(50%\)/);
      const meta = await sharp(output).metadata();
      assert.deepEqual([meta.width, meta.height], [4, 3]);
      const bytes = await readPixels(output);
      assert.deepEqual([...bytes.subarray(12, 16)], [255, 89, 255, 255]);
      assert.deepEqual([...bytes.subarray(0, 4)], [255, 255, 255, 255]);
    }
  });
  await check('JPEG and PNG decoding through installed native dependency', async () => {
    const jpeg = path.join(inputDir, 'after image.jpg');
    await sharp(before).jpeg().toFile(jpeg);
    const output = path.join(inputDir, 'jpeg result.png');
    assert.match(run([before, jpeg, '-o', output, '--fail-on-diff']).stdout, /0 changed pixels/);
    assert.equal((await sharp(output).metadata()).format, 'png');
  });
  await check('invalid arguments, thresholds, missing/corrupt/unsupported inputs, and output errors return 2', async () => {
    const corrupt = path.join(inputDir, 'corrupt.png');
    const unsupported = path.join(inputDir, 'unsupported.gif');
    const directory = path.join(inputDir, 'directory.png');
    await writeFile(corrupt, 'not an image');
    await sharp(before).gif().toFile(unsupported);
    await mkdir(directory);
    const cases = [[], [before], [before, after, '--unknown'], [before, after, '--threshold', ''],
      [before, after, '--threshold', 'bad'], [before, after, '--threshold=-1'], [before, after, '--threshold=1.1'],
      [before, after, '--threshold=Infinity'], [before, after, '--threshold=NaN'],
      ['missing.png', after], [corrupt, after], [unsupported, after],
      [before, after, '-o', 'invalid.jpg'], [before, after, '-o', directory]];
    for (const args of cases) {
      const result = run(args, 2);
      assert.match(result.stderr, /Error:/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
    }
    assert.equal((await stat(directory)).isDirectory(), true);
  });
  await check('ordinary paths, normalized aliases, and hard links cannot overwrite inputs', async () => {
    const hard = path.join(inputDir, 'hard alias.png');
    await link(after, hard);
    const originals = [await readFile(before), await readFile(after)];
    const alias = path.join(inputDir, 'nested directory', '..', path.basename(before));
    for (const output of [before, after, alias, hard]) {
      assert.match(run([before, after, '-o', output], 2).stderr, /must not overwrite/);
    }
    assert.deepEqual(await readFile(before), originals[0]);
    assert.deepEqual(await readFile(after), originals[1]);
  });
  const symbolic = path.join(inputDir, 'symbolic alias.png');
  try {
    await symlink(before, symbolic, 'file');
    await check('symlink aliases cannot overwrite inputs', async () => {
      assert.match(run([before, after, '-o', symbolic], 2).stderr, /must not overwrite/);
    });
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    checks.push({ name: 'symlink aliases cannot overwrite inputs', status: 'skipped', reason: 'Windows file-symlink privilege unavailable; ordinary and hard-link protections passed.' });
    console.log('Packed CLI: symlink check skipped because Windows file-symlink privilege is unavailable.');
  }
  report.status = 'passed';
  }
} catch (error) {
  report.status = 'failed';
  // Store a concise failure without environment variables, install logs, or temporary filesystem paths.
  report.error = error instanceof Error ? error.message.split('\n')[0] : String(error);
  throw error;
} finally {
  if (consumerMode) {
    await writeFile(process.argv[4], JSON.stringify({ status: report.status, checks, ...(report.error ? { error: report.error } : {}) }) + '\n');
  } else {
    if (consumer) {
      try {
        command(process.execPath, ['--input-type=module', '-e',
          "import { rm } from 'node:fs/promises'; await rm(process.argv[1], { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });",
          consumer], root, 0, 15_000);
        report.cleanup = { status: 'passed' };
      } catch (error) {
        report.status = 'failed';
        report.cleanup = { status: 'failed', error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
        process.exitCode = 1;
        console.error('Clean consumer removal failed or exceeded its 15-second limit.');
      }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(path.join(releaseDir, 'package-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
