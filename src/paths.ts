import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const windowsPath = (value: string): boolean => /^(?:[a-z]:|\\\\|\/\/)/i.test(value);
const slashes = (value: string): string => value.replaceAll('\\', '/');
function basename(value: string): string {
  if (windowsPath(value)) {
    const normalized = slashes(value).replace(/\/+$/, '').toLowerCase();
    const root = slashes(path.win32.parse(value).root).replace(/\/+$/, '').toLowerCase();
    return normalized === root ? '[external]' : path.win32.basename(value) || '[external]';
  }
  return slashes(value).replace(/\/+$/, '').split('/').at(-1) || '[external]';
}

/** Presentation only: never use a shortened path for filesystem access or safety checks. */
export function portablePath(filename: string, base = process.cwd()): string {
  const baseWindows = windowsPath(base);
  const filenameWindows = windowsPath(filename);
  const filenamePosix = !filenameWindows && filename.startsWith('/');
  if ((filenameWindows && !baseWindows) || (filenamePosix && baseWindows)) return basename(filename);
  const dialect = baseWindows ? path.win32 : path.posix;
  const relative = dialect.relative(dialect.resolve(base), dialect.resolve(base, filename));
  if (dialect.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) return basename(filename);
  return slashes(relative) || '.';
}

function variants(filename: string): string[] {
  const normalized = slashes(filename);
  return [...new Set([filename, normalized, JSON.stringify(filename).slice(1, -1)])].filter(Boolean);
}

function replaceAlias(message: string, alias: string, label: string): string {
  let offset = 0;
  let result = '';
  while (offset < message.length) {
    const index = message.indexOf(alias, offset);
    if (index < 0) break;
    const before = message[index - 1];
    const after = message[index + alias.length];
    // Avoid replacing part of another filename, a URL, or a longer directory name.
    const start = index === 0 || /[\s"'`(<>=:,\[]/.test(before);
    const end = after === undefined || /[\\/\s"'`):,;\]}>]/.test(after);
    result += message.slice(offset, index) + (start && end ? label : alias);
    offset = index + alias.length;
  }
  return result + message.slice(offset);
}

/**
 * Remove local machine paths from diagnostics for --relative reports.
 * Known paths keep useful portable labels. For an unknown native path, retain
 * only the diagnostic prefix: arbitrary error suffixes can repeat private paths.
 */
export function relativeError(message: string, knownPaths: Iterable<string> = [], base = process.cwd()): string {
  const aliases = new Map<string, string>();
  const register = (filename: string, label: string) => {
    for (const alias of variants(filename)) if (!aliases.has(alias)) aliases.set(alias, label);
  };
  for (const filename of knownPaths) {
    if (!filename) continue;
    const label = portablePath(filename, base);
    register(filename, label);
    const dialect = windowsPath(base) || windowsPath(filename) ? path.win32 : path.posix;
    const absolute = dialect.resolve(base, filename);
    register(absolute, label);
    // realpath may differ from a requested symlink, or from macOS /var aliases.
    // Windows examples must remain host-independent when running on POSIX.
    if (process.platform === 'win32' || !windowsPath(absolute)) {
      try { register(realpathSync.native(absolute), label); } catch { /* Missing inputs still need diagnostics. */ }
    }
  }
  register(base, '.');
  if (process.platform === 'win32' || !windowsPath(base)) {
    try { register(realpathSync.native(base), '.'); } catch { /* A supplied presentation base can be nonexistent. */ }
  }
  register(homedir(), '[home]');
  let result = message;
  for (const [alias, label] of [...aliases].sort((a, b) => b[0].length - a[0].length)) {
    result = replaceAlias(result, alias, label);
  }
  // A bare relative path is safe; parent traversal and absolute paths are not.
  // Root markers require a token boundary so URLs and ordinary a/b labels survive.
  const unknown = /(?:^|[\s"'`(<>=,\[]|:(?!\/\/))(?:file:\/\/|[a-z]:[\\/]|\\\\|\/|(?:\.\.[\\/])+)/i.exec(result);
  if (!unknown) return result;
  const pathStart = unknown.index + (/^[\s"'`(<>=,:\[]/.test(unknown[0]) ? 1 : 0);
  const prefix = result.slice(0, pathStart).replace(/[\s"'`(<>=,:\[]+$/, '');
  const code = /\b(E[A-Z0-9]{2,})\b/.exec(result)?.[1];
  const diagnostic = prefix || 'Operation failed for';
  return `${diagnostic} [local path]${code && !diagnostic.includes(code) ? ` (${code})` : ''}.`;
}
