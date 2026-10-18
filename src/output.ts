import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalPath, contains, missing } from './discovery.js';

const marker = '.diffglow-report';
const ownership = { tool: 'diffglow', schemaVersion: 1 };

async function ownedOrEmpty(directory: string): Promise<boolean> {
  let info;
  try { info = await lstat(directory); } catch (error) { if (missing(error)) return false; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Report output must be a directory, not a file or symbolic link.');
  if ((await readdir(directory)).length === 0) return true;
  try {
    const markerPath = path.join(directory, marker);
    if (!(await lstat(markerPath)).isFile() || (await lstat(markerPath)).isSymbolicLink()) throw new Error('invalid marker');
    const value = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>;
    if (value.tool !== ownership.tool || value.schemaVersion !== ownership.schemaVersion) throw new Error('invalid marker');
  } catch {
    throw new Error('Report output is not empty or Diffglow-owned. Choose a separate --output-dir.');
  }
  return true;
}

export interface ReportDirectory {
  directory: string;
  staging: string;
  publish(): Promise<void>;
  discard(): Promise<void>;
}

export async function prepareReport(directory: string, inputs: string[], roots: string[]): Promise<ReportDirectory> {
  const requested = path.resolve(directory);
  // Check the link itself before canonicalization; do not replace a linked directory.
  await ownedOrEmpty(requested);
  const destination = await canonicalPath(requested);
  const protectedInputs = await Promise.all(inputs.map(async input => {
    try { return await canonicalPath(input); } catch { return path.resolve(input); }
  }));
  for (const input of [...protectedInputs, ...roots]) {
    if (contains(destination, input)) throw new Error('Report output must not equal or contain an input image or folder.');
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(destination), '.diffglow-stage-'));
  try { await writeFile(path.join(staging, marker), JSON.stringify(ownership) + '\n', { flag: 'wx' }); }
  catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  let published = false;
  return {
    directory: destination, staging,
    async publish() {
      // Revalidate immediately before promotion. All writes took place in fresh staging.
      await ownedOrEmpty(requested);
      if (await canonicalPath(requested) !== destination) throw new Error('Report output location changed during processing.');
      const exists = await ownedOrEmpty(destination);
      const backup = path.join(path.dirname(destination), `.diffglow-backup-${randomUUID()}`);
      if (exists) await rename(destination, backup);
      try { await rename(staging, destination); published = true; }
      catch (error) { if (exists) await rename(backup, destination); throw error; }
      if (exists) await rm(backup, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
    async discard() { if (!published) await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  };
}
