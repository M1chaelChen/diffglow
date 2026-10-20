import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  if (!/\.(?:js|json|md|txt|map|ya?ml)$/.test(filename) && !/^(?:LICENSE|NOTICE)$/.test(filename)) return;
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
    const allowed = /^(?:package\.json|README\.md|LICENSE|NOTICE|THIRD_PARTY_NOTICES\.md|dist\/[A-Za-z0-9_.-]+\.js|licenses\/[A-Za-z0-9_./-]+|docs\/demo\.png|skills\/diffglow\/(?:SKILL\.md|agents\/openai\.yaml|references\/(?:playwright|maestro|verification)\.md))$/;
    for (const [filename, content] of files) {
      assert.match(filename, allowed, `Unintended packed file: ${filename}`);
      inspectText(filename, content);
    }
    for (const required of ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'dist/cli.js', 'dist/color.js', 'dist/regions.js', 'dist/diff.js', 'dist/report.js', 'dist/discovery.js', 'dist/output.js', 'dist/batch.js', 'dist/html.js', 'docs/demo.png', 'skills/diffglow/SKILL.md', 'skills/diffglow/agents/openai.yaml', 'skills/diffglow/references/playwright.md', 'skills/diffglow/references/maestro.md', 'skills/diffglow/references/verification.md']) {
      assert.ok(files.has(required), `Missing packed release file: ${required}`);
    }
    for (const [filename, content] of files) {
      if (filename !== 'README.md' && !/^skills\/diffglow\/.*\.md$/.test(filename)) continue;
      for (const match of content.toString().matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1];
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename), decodeURIComponent(target.split('#')[0])));
        assert.ok(files.has(resolved), `${filename} links to a file excluded from npm: ${target}`);
      }
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
  function runJSON(args, expected = 0) {
    const result = run([...args, '--json'], expected);
    assert.equal(result.stderr, '', 'JSON mode must not write human-readable errors or progress to stderr.');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.exitCode, expected);
    return payload;
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
    const help = run(['--help']).stdout;
    assert.match(help, /Usage: diffglow/);
    assert.match(help, /--ignore-region/);
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
  await check('installed custom highlight colors, config overrides, HTML legend, and rendering JSON', async () => {
    const output = path.join(inputDir, 'green diff.png');
    const payload = runJSON([before, after, '--output', output, '--highlight-color', '#0F0', '--fail-on-diff'], 1);
    assert.deepEqual(payload.rendering, { highlightColor: '#00ff00', highlightOpacity: 0.65 });
    assert.equal(payload.stats.changedPixels, 4);
    const highlighted = await readPixels(output);
    assert.deepEqual([...highlighted.subarray((2 * 8 + 3) * 4, (2 * 8 + 3) * 4 + 4)], [0, 201, 70, 255]);
    assert.deepEqual([...highlighted.subarray(0, 4)], [255, 255, 255, 255]);
    const config = path.join(inputDir, 'color config.json');
    await writeFile(config, JSON.stringify({ highlightColor: '#0af' }));
    const configured = runJSON([before, after, '--output', output, '--config', config, '--html',
      '--output-dir', path.join(inputDir, 'color report')]);
    assert.deepEqual(configured.rendering, { highlightColor: '#00aaff', highlightOpacity: 0.65 });
    assert.match(await readFile(path.join(inputDir, 'color report', 'index.html'), 'utf8'), /Highlights use .*#00aaff at 65% opacity/);
    const override = runJSON([before, after, '--output', output, '--config', config, '--highlight-color', '#000']);
    assert.deepEqual(override.rendering, { highlightColor: '#000000', highlightOpacity: 0.65 });
    assert.deepEqual(override.stats, configured.stats);
  });
  await check('installed JSON result reports exact changes, absolute paths, settings, and output before exit 1', async () => {
    const relativeOutput = path.join('json results', 'highlighted image.png');
    const output = path.join(inputDir, relativeOutput);
    const payload = runJSON([path.basename(before), path.basename(after), '--output', relativeOutput,
      '--threshold', '0.2', '--fail-on-diff'], 1);
    assert.equal(payload.status, 'different');
    assert.deepEqual(payload.before, { path: before, width: 8, height: 6 });
    assert.deepEqual(payload.after, { path: after, width: 8, height: 6 });
    assert.deepEqual(payload.output, { path: output, width: 8, height: 6 });
    for (const image of [payload.before, payload.after, payload.output]) assert.ok(path.isAbsolute(image.path));
    assert.deepEqual(payload.comparison, {
      threshold: 0.2, includeAntiAliasing: false, alignment: 'top-left', dimensionsChanged: false, ignoreRegions: []
    });
    assert.equal(payload.stats.comparedPixels, 48);
    assert.equal(payload.stats.ignoredPixels, 0);
    assert.equal(payload.stats.changedPixels, 4);
    assert.equal(payload.stats.unchangedPixels, 44);
    assert.equal(payload.stats.modifiedPixels, 4);
    assert.equal(payload.stats.addedPixels, 0);
    assert.equal(payload.stats.removedPixels, 0);
    assert.ok(Math.abs(payload.stats.changedPercentage - 4 / 48 * 100) < 1e-6);
    assert.deepEqual(payload.stats.diffBounds, { x: 3, y: 2, width: 2, height: 2 });
    assert.equal((await stat(output)).isFile(), true, 'JSON exit 1 must happen after writing the image.');
    const metadata = await sharp(output).metadata();
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ['png', 8, 6]);
  });
  await check('installed JSON identical result has zero changes and null bounds', async () => {
    const output = path.join(inputDir, 'json results', 'identical.png');
    const payload = runJSON([before, before, '-o', output, '--fail-on-diff']);
    assert.equal(payload.status, 'identical');
    assert.deepEqual(payload.stats, {
      comparedPixels: 48, changedPixels: 0, unchangedPixels: 48, changedPercentage: 0,
      modifiedPixels: 0, addedPixels: 0, removedPixels: 0, ignoredPixels: 0, diffBounds: null
    });
    assert.deepEqual(payload.comparison, {
      threshold: 0.1, includeAntiAliasing: false, alignment: 'top-left', dimensionsChanged: false, ignoreRegions: []
    });
    assert.equal(payload.output.path, output);
    assert.deepEqual(await readPixels(output), await readPixels(before));
  });
  await check('installed JSON argument errors return a structured stdout result and exit 2', async () => {
    const payload = runJSON([before, after, '--threshold', 'invalid'], 2);
    assert.equal(payload.status, 'error');
    assert.equal(typeof payload.error?.message, 'string');
    assert.match(payload.error.message, /threshold/i);
    assert.doesNotMatch(payload.error.message, /\n\s+at /);
    assert.deepEqual(Object.keys(payload).sort(), ['error', 'exitCode', 'schemaVersion', 'status']);
  });
  await check('installed ignore regions suppress clock changes, union repeated rectangles, and retain real changes', async () => {
    const output = path.join(inputDir, 'ignored clock.png');
    const regions = [{ x: 3, y: 2, width: 1, height: 2 }, { x: 4, y: 2, width: 1, height: 2 }];
    const ignored = runJSON([before, after, '-o', output, '--ignore-region', '3,2,1,2',
      '--ignore-region', '4,2,1,2', '--ignore-region', '3,2,1,2', '--fail-on-diff']);
    assert.equal(ignored.status, 'identical');
    assert.deepEqual(ignored.comparison.ignoreRegions, [...regions, regions[0]]);
    assert.equal(ignored.stats.changedPixels, 0); assert.equal(ignored.stats.ignoredPixels, 4);
    assert.equal(ignored.stats.comparedPixels, 44); assert.equal(ignored.stats.unchangedPixels, 44);
    assert.equal(ignored.stats.changedPercentage, 0); assert.equal(ignored.stats.diffBounds, null);
    assert.deepEqual(await readPixels(output), await readPixels(after), 'Ignored current pixels must remain visible without highlights.');
    const current = Buffer.from(data); current.set([0, 0, 0, 255], 0);
    const realChange = await image('clock and real change.png', 8, 6, current);
    const changed = runJSON([before, realChange, '-o', output, '--ignore-region', '3,2,2,2', '--fail-on-diff'], 1);
    assert.equal(changed.stats.changedPixels, 1); assert.equal(changed.stats.ignoredPixels, 4);
    assert.equal(changed.stats.changedPercentage, 1 / 44 * 100);
    assert.deepEqual(changed.stats.diffBounds, { x: 0, y: 0, width: 1, height: 1 });
    const highlighted = await readPixels(output);
    assert.deepEqual([...highlighted.subarray(0, 4)], [166, 0, 166, 255]);
    const clockOffset = (2 * 8 + 3) * 4;
    assert.deepEqual(highlighted.subarray(clockOffset, clockOffset + 4), current.subarray(clockOffset, clockOffset + 4));
    const all = runJSON([before, realChange, '-o', output, '--ignore-region', '0,0,999,999', '--fail-on-diff']);
    assert.equal(all.stats.ignoredPixels, 48); assert.equal(all.stats.comparedPixels, 0);
    assert.equal(all.stats.changedPixels, 0); assert.equal(all.stats.changedPercentage, 0);
    assert.deepEqual(await readPixels(output), await readPixels(realChange));
  });
  await check('installed folder config carries ignore regions into JSON, HTML, image assets, and CLI overrides', async () => {
    const root = path.join(inputDir, 'ignored status bar screenshots');
    const baseline = path.join(root, 'baseline'); const current = path.join(root, 'current');
    await mkdir(baseline, { recursive: true }); await mkdir(current);
    await copyFile(before, path.join(baseline, 'mobile.png')); await copyFile(after, path.join(current, 'mobile.png'));
    const regions = [{ x: 3, y: 2, width: 2, height: 2 }];
    await writeFile(path.join(root, 'diffglow.config.json'), JSON.stringify({ ignoreRegions: regions }));
    const output = path.join(inputDir, 'ignored status bar report');
    const payload = runJSON([root, '--output-dir', output, '--html', '--fail-on-diff']);
    assert.equal(payload.status, 'identical'); assert.equal(payload.summary.identical, 1);
    assert.equal(payload.summary.ignoredPixels, 4); assert.equal(payload.summary.comparedPixels, 44);
    assert.equal(payload.summary.changedPixels, 0); assert.deepEqual(payload.comparison.ignoreRegions, regions);
    const entry = payload.results[0]; assert.deepEqual(entry.comparison.ignoreRegions, regions);
    assert.equal(entry.stats.ignoredPixels, 4); assert.equal(entry.stats.changedPixels, 0);
    assert.deepEqual(await readPixels(path.join(output, entry.artifacts.diff)), await readPixels(after));
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    assert.match(html, /ignored/i);
    const embedded = /<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(embedded); assert.deepEqual(JSON.parse(embedded[1]), payload);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8')), payload);
    const override = runJSON([root, '--output-dir', output, '--ignore-region', '3,2,1,2', '--fail-on-diff'], 1);
    assert.deepEqual(override.comparison.ignoreRegions, [{ x: 3, y: 2, width: 1, height: 2 }]);
    assert.equal(override.summary.ignoredPixels, 2); assert.equal(override.summary.changedPixels, 2);
    assert.equal((await stat(override.results[0].output.path)).isFile(), true);
  });
  await check('installed invalid ignore regions return exit 2 without replacing output', async () => {
    const output = path.join(inputDir, 'preserved ignore result.png'); const sentinel = Buffer.from('preserve existing output');
    await writeFile(output, sentinel);
    for (const value of ['', '0,0,0,1', '-1,0,1,1', '0,0,1.5,2', '0,0,1', '9007199254740991,0,1,1']) {
      const payload = runJSON([before, after, '-o', output, `--ignore-region=${value}`], 2);
      assert.match(payload.error.message, /ignore region/i); assert.deepEqual(await readFile(output), sentinel);
    }
    const config = path.join(inputDir, 'invalid ignore config.json');
    await writeFile(config, JSON.stringify({ ignoreRegions: [{ x: 0, y: 0, width: 0, height: 1 }] }));
    const payload = runJSON([before, after, '-o', output, '--config', config, '--ignore-region', '0,0,1,1'], 2);
    assert.match(payload.error.message, /ignore region/i); assert.deepEqual(await readFile(output), sentinel);
  });
  await check('installed folder batch produces portable HTML assets, weighted JSON, missing sides, and continued errors', async () => {
    const root = path.join(inputDir, 'batch screenshots');
    const baseline = path.join(root, 'baseline');
    const current = path.join(root, 'current');
    const output = path.join(inputDir, 'batch report');
    await mkdir(baseline, { recursive: true }); await mkdir(current);
    await copyFile(before, path.join(baseline, 'changed.png'));
    await copyFile(after, path.join(current, 'changed.png'));
    await copyFile(before, path.join(baseline, 'removed.png'));
    await copyFile(before, path.join(current, 'added.png'));
    await copyFile(before, path.join(baseline, 'broken.png'));
    await writeFile(path.join(current, 'broken.png'), 'invalid image');
    const payload = runJSON([root, '--output-dir', output, '--html', '--fail-on-diff'], 2);
    assert.equal(payload.mode, 'batch'); assert.equal(payload.status, 'error');
    assert.deepEqual(payload.results.map(item => [item.id, item.status]), [
      ['added.png', 'added'], ['broken.png', 'error'], ['changed.png', 'different'], ['removed.png', 'removed']
    ]);
    assert.equal(payload.summary.comparedPixels, 144);
    assert.equal(payload.summary.changedPixels, 100);
    assert.equal(payload.summary.changedPercentage, 100 / 144 * 100);
    const html = await readFile(path.join(output, 'index.html'), 'utf8');
    assert.match(html, /Baseline vs current/); assert.match(html, /Comparison failed/);
    assert.match(html, /id="search"/); assert.match(html, /id="status"/);
    assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["'](?:https?:|\/\/)/i);
    for (const result of payload.results) {
      if (result.status === 'error') continue;
      for (const asset of Object.values(result.artifacts)) if (asset) {
        assert.ok(!path.isAbsolute(asset)); await access(path.join(output, asset));
      }
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8')), payload);
    await rm(path.join(current, 'broken.png'));
    await rm(path.join(baseline, 'broken.png'));
    const next = runJSON([baseline, current, '--output-dir', output, '--fail-on-diff'], 1);
    assert.equal(next.summary.errors, 0);
    await assert.rejects(access(path.join(output, 'index.html')), { code: 'ENOENT' });
  });
  await check('installed config templates and manifest resolve nested paths without development tooling', async () => {
    const root = path.join(inputDir, 'named screenshots'); await mkdir(root);
    await copyFile(before, path.join(root, 'home.baseline.png'));
    await copyFile(after, path.join(root, 'home.current.png'));
    await writeFile(path.join(root, 'diffglow.config.json'), JSON.stringify({
      baselineDir: '.', currentDir: '.', baselinePattern: '{key}.baseline.{ext}', currentPattern: '{key}.current.{ext}'
    }));
    const payload = runJSON([root, '--html', '--output-dir', path.join(root, 'report'), '--fail-on-diff'], 1);
    assert.equal(payload.results.length, 1); assert.equal(payload.results[0].id, 'home');
    assert.equal(payload.summary.changedPixels, 4);
    const manifest = path.join(root, 'pairs.json');
    await writeFile(manifest, JSON.stringify({ pairs: [{ id: 'named comparison', before: 'home.baseline.png', after: 'home.current.png' }] }));
    const explicit = runJSON(['--manifest', manifest, '--output-dir', path.join(inputDir, 'manifest report'), '--html']);
    assert.equal(explicit.results[0].id, 'named comparison');
    assert.equal(explicit.summary.changedPixels, 4);
    const singleOutput = path.join(inputDir, 'single html.png');
    const single = runJSON([before, after, '--html', '-o', singleOutput, '--output-dir', path.join(inputDir, 'single report')]);
    assert.equal(single.stats.changedPixels, 4); assert.equal(single.mode, undefined);
    assert.equal((await sharp(singleOutput).metadata()).format, 'png');
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
      [before, after, '--highlight-color', ''], [before, after, '--highlight-color', 'green'],
      [before, after, '--highlight-color', '#00000000'], [before, after, '--highlight-color'],
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
