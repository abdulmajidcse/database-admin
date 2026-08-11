/**
 * Directory listing for the SQLite file picker and the export-destination
 * picker (PLAN §7.2 + §10.4).
 *
 * Two rules define this endpoint:
 *
 *  1. **Every path is confined.** `resolveWithin()` is applied to the requested
 *     path, and then the resolved directory is compared against the root's
 *     *real* path — otherwise a symlink inside the root would walk straight out
 *     of it and turn a file picker into an arbitrary-file browser (§7.2).
 *  2. **Every path is a CONTAINER path.** `/data/sqlite` means nothing to
 *     someone looking at their Mac, so the response carries the root it is
 *     confined to, plus the host directory when the mount told us about it
 *     (§10.4).
 *
 * POST rather than GET because the body is a small structured request and this
 * is a mutation-free but non-cacheable read; the token check in server.ts
 * applies either way.
 */

import { constants as FS, type Stats } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG, IS_CONTAINER, resolveWithin } from '@/server/config';
import { asRecord, handle, HttpError, oneOf, optionalBoolean, optionalString, readJson } from '../lib/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which confined root to browse. */
export type FileRootKey = 'sqlite' | 'export';

export interface FilesRequest {
  root: FileRootKey;
  /** Relative to the root, or an absolute container path inside it. Default: the root. */
  path?: string;
  /** Dotfiles are hidden by default. */
  showHidden?: boolean;
  /** Keep only files with these extensions (directories always shown). */
  extensions?: string[];
}

export interface FileEntry {
  name: string;
  /** Absolute CONTAINER path — what a connection or export request stores. */
  path: string;
  /** Path relative to the root, for breadcrumbs. */
  relativePath: string;
  isDir: boolean;
  sizeBytes: number;
  /** Alias of `sizeBytes`; the file-picker component reads `size`. */
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  isSymlink: boolean;
}

export interface FileRootInfo {
  key: FileRootKey;
  /** The container path everything is confined to. */
  path: string;
  label: string;
  /** The host directory mounted here, when the deployment passed it through. */
  hostPath: string | null;
  /** Human explanation of the container↔host mapping (§10.4). */
  note: string | null;
  isContainer: boolean;
}

export interface FilesResponse {
  root: FileRootInfo;
  /** Absolute container path that was listed. */
  path: string;
  relativePath: string;
  /** Absolute path of the parent, or null at the root — there is no "up" past it. */
  parent: string | null;
  writable: boolean;
  entries: FileEntry[];
  truncated: boolean;
}

/** A directory with tens of thousands of files must not become a 40 MB JSON. */
const MAX_ENTRIES = 2000;

export async function POST(req: Request): Promise<Response> {
  return handle(async (): Promise<FilesResponse> => {
    const body = asRecord(await readJson<unknown>(req));
    const rootKey = oneOf<FileRootKey>(body.root ?? 'sqlite', ['sqlite', 'export'], 'root');
    const requested = optionalString(body, 'path') ?? '';
    const showHidden = optionalBoolean(body, 'showHidden') ?? false;
    const extensions = parseExtensions(body.extensions);

    const rootPath = rootKey === 'sqlite' ? CONFIG.sqliteRoot : CONFIG.exportRoot;

    // A fresh install has no mounted directory yet; creating it is friendlier
    // than a 404 on the very first click. A read-only mount just falls through
    // to the stat below, which reports the real problem.
    await mkdir(rootPath, { recursive: true }).catch(() => undefined);

    const rootReal = await realpath(rootPath).catch(() => {
      throw new HttpError(
        `The ${rootKey} directory ${rootPath} does not exist inside the container. ${mountHint(rootKey)}`,
        404,
        { code: 'ROOT_MISSING' },
      );
    });

    const target = confine(rootPath, requested, rootKey);
    const targetStat = await stat(target);
    if (!targetStat.isDirectory()) {
      throw new HttpError(`${target} is a file, not a directory.`, 400, { code: 'ENOTDIR' });
    }
    // The lexical check above cannot see symlinks: a link inside the root that
    // points at /etc resolves cleanly and would otherwise be browsable (§7.2).
    const targetReal = await realpath(target);
    if (!withinReal(rootReal, targetReal)) {
      throw new HttpError(
        `That path is a link out of the ${rootKey} directory (${rootPath}), which is the only place this picker can browse.`,
        403,
        { code: 'PATH_ESCAPE', hint: mountHint(rootKey) },
      );
    }

    const dirents = await readdir(target, { withFileTypes: true });
    const entries: FileEntry[] = [];
    let truncated = false;

    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      if (!showHidden && dirent.name.startsWith('.')) continue;

      const full = path.join(target, dirent.name);
      let info: Stats;
      try {
        info = await lstat(full);
      } catch {
        // Vanished between readdir and lstat, or unreadable — skip it rather
        // than failing the whole listing.
        continue;
      }

      const isSymlink = info.isSymbolicLink();
      let isDir = info.isDirectory();
      let sizeBytes = info.size;
      let mtime = info.mtimeMs;

      if (isSymlink) {
        // §7.2: a symlink is only shown when its target is inside the root too.
        const resolved = await realpath(full).catch(() => null);
        if (!resolved || !withinReal(rootReal, resolved)) continue;
        const linked = await stat(full).catch(() => null);
        if (!linked) continue;
        isDir = linked.isDirectory();
        sizeBytes = linked.size;
        mtime = linked.mtimeMs;
      }

      if (!isDir && extensions && !extensions.has(path.extname(dirent.name).toLowerCase())) continue;

      entries.push({
        name: dirent.name,
        path: full,
        relativePath: path.relative(rootPath, full),
        isDir,
        sizeBytes: isDir ? 0 : sizeBytes,
        size: isDir ? 0 : sizeBytes,
        mtime: Math.round(mtime),
        isSymlink,
      });
    }

    // Directories first, then case-insensitive by name: the order a file picker
    // is expected to have.
    entries.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1,
    );

    const relativePath = path.relative(rootPath, target);
    const writable = await access(target, FS.W_OK).then(
      () => true,
      () => false,
    );

    return {
      root: rootInfo(rootKey, rootPath),
      path: target,
      relativePath,
      // No "up" past the root — the picker must not offer a way out of it.
      parent: relativePath === '' ? null : path.dirname(target),
      writable,
      entries,
      truncated,
    };
  });
}

/**
 * `resolveWithin` handles `..` and absolute paths; the realpath comparison
 * afterwards handles symlinks, which `path.resolve` knows nothing about.
 */
function confine(rootPath: string, requested: string, rootKey: FileRootKey): string {
  let resolved: string;
  try {
    resolved = resolveWithin(rootPath, requested);
  } catch {
    throw new HttpError(
      `That path is outside the ${rootKey} directory (${rootPath}), which is the only place this picker can browse.`,
      403,
      { code: 'PATH_ESCAPE', hint: mountHint(rootKey) },
    );
  }
  return resolved;
}

function withinReal(rootReal: string, candidate: string): boolean {
  if (candidate === rootReal) return true;
  const rel = path.relative(rootReal, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function rootInfo(key: FileRootKey, rootPath: string): FileRootInfo {
  const hostPath = hostDirFor(key);
  return {
    key,
    path: rootPath,
    label: key === 'sqlite' ? 'SQLite files' : 'Exports',
    hostPath,
    note: IS_CONTAINER
      ? hostPath
        ? `${rootPath} in this container is ${hostPath} on your machine.`
        : `These are paths inside the container. ${mountHint(key)}`
      : null,
    isContainer: IS_CONTAINER,
  };
}

/**
 * compose.yml mounts `${DBADMIN_SQLITE_DIR}` at `/data/sqlite`, but that value
 * lives on the host. If the deployment passes it through we can name the real
 * directory; otherwise we explain the mapping instead of pretending to know it.
 */
function hostDirFor(key: FileRootKey): string | null {
  const names =
    key === 'sqlite'
      ? ['DBADMIN_SQLITE_HOST_DIR', 'DBADMIN_SQLITE_DIR']
      : ['DBADMIN_EXPORT_HOST_DIR', 'DBADMIN_EXPORT_DIR'];
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return null;
}

function mountHint(key: FileRootKey): string {
  const composeVar = key === 'sqlite' ? 'DBADMIN_SQLITE_DIR' : 'DBADMIN_EXPORT_DIR';
  const mount = key === 'sqlite' ? CONFIG.sqliteRoot : CONFIG.exportRoot;
  return IS_CONTAINER
    ? `Mount the host directory you want here: set ${composeVar} before \`docker compose up\`, which bind-mounts it at ${mount}.`
    : `Put files under ${mount}, or set ${key === 'sqlite' ? 'DBADMIN_SQLITE_ROOT' : 'DBADMIN_EXPORT_ROOT'} to browse somewhere else.`;
}

function parseExtensions(value: unknown): Set<string> | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new HttpError('"extensions" must be an array of strings.', 400);
  const out = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw === '') continue;
    out.add((raw.startsWith('.') ? raw : `.${raw}`).toLowerCase());
  }
  return out.size > 0 ? out : null;
}
