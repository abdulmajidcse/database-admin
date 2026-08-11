'use client';

/**
 * Container filesystem browser (PLAN §7.2 confinement, §10.4 container paths).
 *
 * POST /api/files lists ONE confined root — `/data/sqlite` or `/data/exports` —
 * and refuses anything outside it, symlinks included. The rule this component
 * exists to honour is §10.4: **every path here is a container path**, so the
 * host directory the root maps to is shown permanently at the top, not buried in
 * a tooltip. `/data/exports` means nothing to someone looking at their Mac.
 *
 * Two modes: `open` picks an existing file, `save` picks a directory plus a
 * filename (the export destination). Both return one absolute container path.
 */

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, FolderOpen, HardDrive, RefreshCw, TriangleAlert } from 'lucide-react';
import { api, ApiRequestError } from '@/lib/api-client';
import { formatBytes } from '@/hooks/use-jobs';
import { Badge, Button, Checkbox, Dialog, ErrorBox, Field, Input, Spinner, cn } from '@/components/ui/primitives';

export type FileRootKey = 'sqlite' | 'export';

export const ROOT_LABELS: Record<FileRootKey, string> = {
  export: 'Exports',
  sqlite: 'SQLite files',
};

interface Entry {
  name: string;
  /** Absolute CONTAINER path. */
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
  isSymlink: boolean;
}

interface Listing {
  /** Absolute container path that was listed. */
  path: string;
  relativePath: string;
  parent: string | null;
  writable: boolean;
  truncated: boolean;
  entries: Entry[];
  root: {
    path: string;
    label: string;
    hostPath: string | null;
    note: string | null;
    isContainer: boolean;
  };
}

/**
 * The route's own response shape is server-side (it imports node:fs), so it is
 * re-declared here and normalized defensively rather than imported.
 */
function normalizeListing(payload: unknown, requested: string, rootKey: FileRootKey): Listing {
  const rec = isRecord(payload) ? payload : {};
  const rootRec = isRecord(rec.root) ? rec.root : {};
  const base = typeof rec.path === 'string' ? rec.path : requested;
  const entries: Entry[] = [];
  for (const raw of Array.isArray(rec.entries) ? rec.entries : []) {
    if (!isRecord(raw)) continue;
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (name === '') continue;
    entries.push({
      name,
      path: typeof raw.path === 'string' ? raw.path : joinPath(base, name),
      isDir: raw.isDir === true,
      size: typeof raw.size === 'number' ? raw.size : typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
      mtime: typeof raw.mtime === 'number' ? raw.mtime : 0,
      isSymlink: raw.isSymlink === true,
    });
  }
  entries.sort((a, b) =>
    a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isDir ? -1 : 1,
  );
  return {
    path: base,
    relativePath: typeof rec.relativePath === 'string' ? rec.relativePath : '',
    parent: typeof rec.parent === 'string' ? rec.parent : null,
    writable: rec.writable !== false,
    truncated: rec.truncated === true,
    entries,
    root: {
      path: typeof rootRec.path === 'string' ? rootRec.path : base,
      label: typeof rootRec.label === 'string' ? rootRec.label : ROOT_LABELS[rootKey],
      hostPath: typeof rootRec.hostPath === 'string' ? rootRec.hostPath : null,
      note: typeof rootRec.note === 'string' ? rootRec.note : null,
      isContainer: rootRec.isContainer === true,
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function joinPath(dir: string, name: string): string {
  if (name.startsWith('/')) return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

export function dirName(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

export interface FilePickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  /** Which confined root to start in. */
  root?: FileRootKey;
  /** Offer a switcher when a flow legitimately reads from either root. */
  roots?: FileRootKey[];
  /** `save` adds a filename field and returns directory + name. */
  mode?: 'open' | 'save';
  /** Extension filter, e.g. ['.csv', '.tsv']. Directories are always listed. */
  extensions?: string[];
  /** Pre-filled filename in `save` mode. */
  defaultName?: string;
  /** A directory, or a file whose directory is opened. */
  initialPath?: string;
  title?: string;
}

export function FilePicker({
  open,
  onClose,
  onPick,
  root = 'export',
  roots,
  mode = 'open',
  extensions,
  defaultName,
  initialPath,
  title,
}: FilePickerProps) {
  const rootChoices = roots && roots.length > 0 ? roots : [root];
  const [rootKey, setRootKey] = React.useState<FileRootKey>(rootChoices[0] ?? root);
  const [dir, setDir] = React.useState<string>('');
  const [name, setName] = React.useState<string>(defaultName ?? '');
  const [showHidden, setShowHidden] = React.useState(false);

  // Reopening resets to what the caller asked for; an initial file path opens
  // its directory with the name pre-filled, which is what "save as" should do.
  React.useEffect(() => {
    if (!open) return;
    setRootKey(rootChoices[0] ?? root);
    if (initialPath && initialPath !== '') {
      const looksLikeFile = /\.[A-Za-z0-9]{1,8}$/.test(initialPath);
      setDir(looksLikeFile ? dirName(initialPath) : initialPath);
      if (mode === 'save' && looksLikeFile) setName(baseName(initialPath));
      else setName(defaultName ?? '');
    } else {
      setDir('');
      setName(defaultName ?? '');
    }
    // Deliberately keyed on `open`: typing inside the dialog must not reset it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const extKey = (extensions ?? []).join(',');
  const listing = useQuery<Listing>({
    queryKey: ['files', rootKey, dir, showHidden, extKey],
    queryFn: async () =>
      normalizeListing(
        await api.post<unknown>('/api/files', {
          root: rootKey,
          path: dir,
          showHidden,
          extensions: extensions && extensions.length > 0 ? extensions : undefined,
        }),
        dir,
        rootKey,
      ),
    enabled: open,
    retry: false,
  });

  const data = listing.data;
  const err = listing.error;
  const chosen = mode === 'save' && data && name.trim() !== '' ? joinPath(data.path, name.trim()) : null;
  const exists = data?.entries.some((e) => !e.isDir && e.name === name.trim()) ?? false;

  function confirmSave(): void {
    if (!chosen) return;
    onPick(chosen);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? (mode === 'save' ? 'Choose a destination file' : 'Choose a file')}
      width="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {mode === 'save' && (
            <Button variant="primary" onClick={confirmSave} disabled={!chosen}>
              Use this path
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {rootChoices.length > 1 && (
          <div className="flex items-center gap-1">
            {rootChoices.map((r) => (
              <Button
                key={r}
                size="xs"
                variant={r === rootKey ? 'primary' : 'subtle'}
                onClick={() => {
                  setRootKey(r);
                  setDir('');
                }}
              >
                {ROOT_LABELS[r]}
              </Button>
            ))}
          </div>
        )}

        {/* §10.4: which host directory this container root maps to, always visible. */}
        <ContainerPathNote listing={data} rootKey={rootKey} />

        <div className="flex items-center gap-1.5">
          <Input
            className="mono"
            value={dir}
            placeholder={data?.root.path ?? '/data'}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void listing.refetch();
            }}
            aria-label="Directory"
          />
          <Button
            size="sm"
            icon={<RefreshCw className={cn('size-3', listing.isFetching && 'animate-spin')} />}
            onClick={() => void listing.refetch()}
            title="Re-read this directory"
          />
        </div>

        {data && data.relativePath !== '' && (
          <p className="mono truncate text-[11px] text-[var(--fg-muted)]" title={data.path}>
            {data.root.label} / {data.relativePath}
          </p>
        )}

        <div className="max-h-72 min-h-32 overflow-y-auto border border-[var(--border)]">
          {listing.isPending && (
            <div className="flex items-center gap-2 p-3 text-xs text-[var(--fg-muted)]">
              <Spinner /> Reading directory…
            </div>
          )}
          {err && (
            <div className="p-3">
              <ErrorBox
                title="Cannot read that directory"
                message={err instanceof Error ? err.message : 'Unknown error'}
                hint={err instanceof ApiRequestError ? err.hint : undefined}
              />
            </div>
          )}
          {data && (
            <>
              {data.parent !== null && (
                <FileRow
                  icon={<ChevronRight className="size-3.5 rotate-180" />}
                  label=".."
                  onClick={() => setDir(data.parent as string)}
                />
              )}
              {data.entries.map((e) => (
                <FileRow
                  key={e.path}
                  icon={e.isDir ? <FolderOpen className="size-3.5" /> : <FileText className="size-3.5" />}
                  label={e.name}
                  detail={e.isDir ? undefined : formatBytes(e.size)}
                  badge={e.isSymlink ? 'link' : undefined}
                  selected={mode === 'save' && !e.isDir && e.name === name.trim()}
                  onClick={() => {
                    if (e.isDir) {
                      setDir(e.path);
                      return;
                    }
                    if (mode === 'save') setName(e.name);
                    else {
                      onPick(e.path);
                      onClose();
                    }
                  }}
                />
              ))}
              {data.entries.length === 0 && (
                <p className="p-3 text-xs text-[var(--fg-subtle)]">
                  This directory is empty{extensions && extensions.length > 0 ? ` (filtered to ${extKey})` : ''}.
                </p>
              )}
              {data.truncated && (
                <p className="border-t border-[var(--border)] p-2 text-[11px] text-[var(--warn)]">
                  Only the first 2000 entries are shown. Narrow the path to see the rest.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Checkbox
            className="text-[11px] text-[var(--fg-muted)]"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
            label="Show dotfiles"
          />
          {data && !data.writable && mode === 'save' && (
            <span className="flex items-center gap-1 text-[11px] text-[var(--warn)]">
              <TriangleAlert className="size-3" /> This directory is not writable by the server.
            </span>
          )}
        </div>

        {mode === 'save' && (
          <Field
            label="File name"
            hint={
              chosen ? (
                <>
                  Writes to <code className="mono">{chosen}</code>
                  {exists ? ' — this file already exists and will be overwritten.' : ''}
                </>
              ) : (
                'The file is created inside the directory above.'
              )
            }
          >
            <Input
              className="mono"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmSave();
              }}
              placeholder="export.csv"
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

/**
 * §10.4. When the deployment passed the host directory through we can name it;
 * otherwise we say plainly that these are container paths and how to mount one,
 * rather than pretending to know the host layout.
 */
function ContainerPathNote({ listing, rootKey }: { listing: Listing | undefined; rootKey: FileRootKey }) {
  const rootPath = listing?.root.path;
  const hostPath = listing?.root.hostPath ?? null;
  const note = listing?.root.note ?? null;
  const composeVar = rootKey === 'sqlite' ? 'DBADMIN_SQLITE_DIR' : 'DBADMIN_EXPORT_DIR';

  return (
    <div className="flex items-start gap-2 border border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1.5">
      <HardDrive className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]" />
      <div className="text-[11px] leading-snug text-[var(--fg-muted)]">
        {hostPath ? (
          <>
            <code className="mono text-[var(--fg)]">{rootPath}</code> in this container is{' '}
            <code className="mono text-[var(--fg)]">{hostPath}</code> on your machine.
          </>
        ) : (
          <>
            {note ?? (
              <>
                Every path here is a path <em>inside the container</em>, confined to{' '}
                <code className="mono text-[var(--fg)]">{rootPath ?? '…'}</code>.
              </>
            )}
            {listing?.root.isContainer && !note && (
              <>
                {' '}
                Set <code className="mono">{composeVar}</code> before <code className="mono">docker compose up</code> to
                mount a host directory here.
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function FileRow({
  icon,
  label,
  detail,
  badge,
  selected,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  badge?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-[var(--bg-hover)]',
        selected && 'bg-[var(--selection)]',
      )}
    >
      <span className="text-[var(--fg-subtle)]">{icon}</span>
      <span className="mono truncate">{label}</span>
      {badge && <Badge>{badge}</Badge>}
      {detail && <span className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--fg-subtle)]">{detail}</span>}
    </button>
  );
}

/**
 * The composite every transfer dialog actually wants: a path box you can type
 * into plus a Browse button wired to the picker.
 */
export function FilePathField({
  value,
  onChange,
  root = 'export',
  roots,
  mode = 'open',
  extensions,
  defaultName,
  placeholder,
  pickerTitle,
  disabled,
}: {
  value: string;
  onChange: (path: string) => void;
  root?: FileRootKey;
  roots?: FileRootKey[];
  mode?: 'open' | 'save';
  extensions?: string[];
  defaultName?: string;
  placeholder?: string;
  pickerTitle?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        className="mono"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button size="sm" onClick={() => setOpen(true)} disabled={disabled} icon={<FolderOpen className="size-3.5" />}>
        Browse
      </Button>
      <FilePicker
        open={open}
        onClose={() => setOpen(false)}
        onPick={onChange}
        root={root}
        roots={roots}
        mode={mode}
        extensions={extensions}
        defaultName={defaultName ?? (value ? baseName(value) : undefined)}
        initialPath={value || undefined}
        title={pickerTitle}
      />
    </div>
  );
}
