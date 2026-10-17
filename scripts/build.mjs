import { spawnSync } from 'node:child_process';
import { chmod, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true });
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const result = spawnSync(process.execPath, [compiler, '--project', 'tsconfig.build.json'], {
  cwd: root, stdio: 'inherit'
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const cli = new URL('../dist/cli.js', import.meta.url);
if (!(await readFile(cli, 'utf8')).startsWith('#!/usr/bin/env node\n')) {
  throw new Error('Compiled executable is missing its Node shebang.');
}
await chmod(cli, 0o755);
