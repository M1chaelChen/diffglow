import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_HIGHLIGHT_COLOR, parseHighlightColor } from './color.js';
import { parseIgnoreRegions, type IgnoreRegion } from './regions.js';

export interface Pair { id: string; before: string | null; after: string | null }
export interface Configuration {
  baselineDir: string;
  currentDir: string;
  include: string[];
  exclude: string[];
  baselinePattern: string;
  currentPattern: string;
  threshold: number;
  highlightColor: string;
  ignoreRegions: IgnoreRegion[];
}
export interface InputSelection {
  mode: 'single' | 'batch';
  pairs: Pair[];
  inputRoots: string[];
  threshold: number;
  highlightColor: string;
  ignoreRegions: IgnoreRegion[];
}
export const defaults: Configuration = {
  baselineDir: 'baseline', currentDir: 'current', include: ['**/*'], exclude: [],
  baselinePattern: '{key}', currentPattern: '{key}', threshold: 0.1, highlightColor: DEFAULT_HIGHLIGHT_COLOR, ignoreRegions: []
};

export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
/** Resolve aliases even when the final output directory has not been created. */
export async function canonicalPath(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  try { return await realpath(absolute); }
  catch (error) {
    if (!missing(error)) throw error;
    // A dangling link must not be mistaken for a safe nonexistent directory.
    try {
      if ((await lstat(absolute)).isSymbolicLink()) throw new Error(`Dangling symbolic link: ${filename}`);
    } catch (linkError) { if (!missing(linkError)) throw linkError; }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

const quoteRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function globMatcher(pattern: string): RegExp {
  if (!pattern || pattern.includes('\\') || /[{}\[\]]/.test(pattern)) {
    throw new Error('Globs must use forward slashes and only *, **, and ? wildcards.');
  }
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if ((i > 0 && pattern[i - 1] !== '/') || (i + 2 < pattern.length && pattern[i + 2] !== '/')) {
        throw new Error('The ** wildcard must occupy a complete path segment.');
      }
      if (pattern[i + 2] === '/') { source += '(?:[^/]+/)*'; i += 2; }
      else { source += '.*'; i++; }
    } else if (pattern[i] === '*') source += '[^/]*';
    else if (pattern[i] === '?') source += '[^/]';
    else source += quoteRegex(pattern[i]);
  }
  return new RegExp(source + '$', 'u');
}
export function templateMatcher(template: string): RegExp {
  if (template.includes('\\') || template.split('{key}').length !== 2 || template.split('{ext}').length > 2 ||
    /[{}]/.test(template.replace('{key}', '').replace('{ext}', ''))) {
    throw new Error('Pairing templates require exactly one {key}, optional {ext}, and forward slashes.');
  }
  const source = template.split(/(\{key\}|\{ext\})/).map(part => {
    if (part === '{key}') return '(?<key>.+)';
    if (part === '{ext}') return '(?:[pP][nN][gG]|[jJ][pP][eE]?[gG])';
    return quoteRegex(part);
  }).join('');
  return new RegExp('^' + source + '$', 'u');
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function jsonFile(filename: string): Promise<unknown> {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { throw new Error(`Cannot read JSON file "${filename}": ${error instanceof Error ? error.message : String(error)}`); }
}
async function configuration(filename?: string): Promise<Configuration> {
  const config: Configuration = { ...defaults, include: [...defaults.include], exclude: [], ignoreRegions: [] };
  if (filename) {
    const data = await jsonFile(filename);
    if (!object(data)) throw new Error('Configuration must be a JSON object.');
    for (const key of Object.keys(data)) {
      if (!(key in defaults) || !Object.hasOwn(defaults, key)) throw new Error(`Unknown configuration option: ${key}`);
      const value = data[key];
      if (key === 'threshold') {
        if (typeof value !== 'number') throw new Error('Configured threshold must be a number.');
        config.threshold = value;
      } else if (key === 'highlightColor') {
        config.highlightColor = parseHighlightColor(value).hex;
      } else if (key === 'ignoreRegions') {
        config.ignoreRegions = parseIgnoreRegions(value);
      } else if (key === 'include' || key === 'exclude') {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0) || (key === 'include' && value.length === 0)) {
          throw new Error(`${key} must be an array of nonempty glob strings${key === 'include' ? ' with at least one entry' : ''}.`);
        }
        config[key] = value as string[];
      } else {
        if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a nonempty string.`);
        Object.assign(config, { [key]: value });
      }
    }
  }
  config.include.forEach(globMatcher); config.exclude.forEach(globMatcher);
  templateMatcher(config.baselinePattern); templateMatcher(config.currentPattern);
  return config;
}

async function folder(filename: string): Promise<string> {
  try {
    const resolved = await realpath(filename);
    if (!(await stat(resolved)).isDirectory()) throw new Error('expected a directory');
    return resolved;
  } catch (error) { throw new Error(`Cannot read screenshot folder "${filename}": ${error instanceof Error ? error.message : String(error)}`); }
}
async function scan(root: string, template: string, config: Configuration, excluded: string): Promise<Map<string, string>> {
  const include = config.include.map(globMatcher);
  const exclude = config.exclude.map(globMatcher);
  const matcher = templateMatcher(template);
  const files = new Map<string, string>();
  async function walk(directory: string) {
    if (contains(excluded, directory)) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && /^\.diffglow-(?:stage|backup)-/.test(entry.name)) continue;
      if (entry.isDirectory()) { await walk(filename); continue; }
      if (!entry.isFile() || !/\.(?:png|jpe?g)$/i.test(entry.name)) continue;
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (!include.some(pattern => pattern.test(relative)) || exclude.some(pattern => pattern.test(relative))) continue;
      const key = matcher.exec(relative)?.groups?.key;
      if (!key) continue;
      if (files.has(key)) throw new Error(`Ambiguous screenshot identity "${key}" in ${root}. Use distinct names or an explicit manifest.`);
      files.set(key, filename);
    }
  }
  await walk(root);
  return files;
}
async function manifestPairs(filename: string): Promise<Pair[]> {
  const manifest = path.resolve(filename);
  const data = await jsonFile(manifest);
  if (!object(data) || Object.keys(data).some(key => key !== 'pairs') || !Array.isArray(data.pairs) || data.pairs.length === 0) {
    throw new Error('Manifest must contain a nonempty pairs array.');
  }
  const seen = new Set<string>();
  return data.pairs.map((entry: unknown) => {
    if (!object(entry) || Object.keys(entry).some(key => !['id', 'before', 'after'].includes(key)) ||
      ['id', 'before', 'after'].some(key => typeof entry[key] !== 'string' || !(entry[key] as string).trim())) {
      throw new Error('Each manifest pair requires nonempty id, before, and after strings.');
    }
    const id = entry.id as string;
    if (seen.has(id)) throw new Error(`Duplicate manifest identity: ${id}`);
    seen.add(id);
    return { id, before: path.resolve(path.dirname(manifest), entry.before as string), after: path.resolve(path.dirname(manifest), entry.after as string) };
  });
}

export async function selectInputs(positionals: string[], options: {
  manifest?: string; config?: string; threshold?: number; highlightColor?: string; ignoreRegions?: IgnoreRegion[]; outputDirectory: string;
}): Promise<InputSelection> {
  if (options.manifest && positionals.length) throw new Error('--manifest cannot be combined with image or folder arguments.');
  let mode: 'single' | 'batch' = 'batch';
  let root: string | undefined;
  let roots: string[] = [];
  if (!options.manifest) {
    if (positionals.length === 1) root = await folder(positionals[0]);
    else if (positionals.length === 2) {
      const kinds = await Promise.all(positionals.map(async filename => {
        try { return (await stat(filename)).isDirectory(); } catch (error) { if (missing(error)) return false; throw error; }
      }));
      if (kinds[0] !== kinds[1]) throw new Error('Use two image files or two screenshot folders; do not mix them.');
      if (kinds[0]) roots = await Promise.all(positionals.map(folder));
      else mode = 'single';
    } else throw new Error('Provide exactly two input images, two folders, one screenshot root, or --manifest. Use --help for usage.');
  }
  let configFile = options.config;
  if (!configFile && root) {
    const candidate = path.join(root, 'diffglow.config.json');
    try { await stat(candidate); configFile = candidate; } catch (error) { if (!missing(error)) throw error; }
  }
  const config = await configuration(configFile);
  const highlightColor = parseHighlightColor(options.highlightColor ?? config.highlightColor).hex;
  const ignoreRegions = parseIgnoreRegions(options.ignoreRegions ?? config.ignoreRegions);
  const threshold = options.threshold ?? config.threshold;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Threshold must be a finite number between 0 and 1.');
  if (mode === 'single') {
    return { mode, pairs: [{ id: 'comparison', before: path.resolve(positionals[0]), after: path.resolve(positionals[1]) }], inputRoots: [], threshold, highlightColor, ignoreRegions };
  }
  let pairs: Pair[];
  if (options.manifest) pairs = await manifestPairs(options.manifest);
  else {
    if (root) roots = await Promise.all([folder(path.resolve(root, config.baselineDir)), folder(path.resolve(root, config.currentDir))]);
    const excluded = await canonicalPath(options.outputDirectory);
    for (const input of roots) if (contains(excluded, input)) throw new Error('The report directory must not equal or contain an input folder.');
    const baseline = await scan(roots[0], config.baselinePattern, config, excluded);
    const current = await scan(roots[1], config.currentPattern, config, excluded);
    pairs = [...new Set([...baseline.keys(), ...current.keys()])].map(id => ({ id, before: baseline.get(id) ?? null, after: current.get(id) ?? null }));
    if (!pairs.length) throw new Error('No PNG/JPEG screenshots matched the configured folders and patterns.');
  }
  pairs.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { mode: 'batch', pairs, inputRoots: roots, threshold, highlightColor, ignoreRegions };
}
