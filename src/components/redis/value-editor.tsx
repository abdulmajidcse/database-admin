'use client';

/**
 * Type-aware Redis value viewer/editor (PLAN M4).
 *
 * Driven entirely by the `TypedValue` union: string, list, set, zset, hash and
 * stream each get the editor that type deserves, and large values are windowed
 * with the API's offset/limit rather than pulled into the browser whole
 * (PLAN §6 — a 10M element list must not be a rendering problem).
 *
 * The one rule that shapes this whole file: `/api/redis/key/write` REPLACES the
 * key (DEL + rebuild inside a MULTI). Saving a window would therefore delete
 * every element outside it, so saving is enabled only once the value is proven
 * complete — see `completeness()`. TTL, rename and delete do not need that proof
 * and go through targeted commands instead of a rewrite.
 */

import * as React from 'react';
import { toast } from 'sonner';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Plus,
  RefreshCw,
  Save,
  Tag,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { api, ApiRequestError } from '../../lib/api-client';
import type { RedisKeyRequest, RedisKeyResponse } from '../../lib/api-types';
import type { TypedValue } from '../../lib/results';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
  Toolbar,
  cn,
} from '../ui/primitives';
import { TypeBadge, formatCount, formatDurationMs, formatTtl } from './keyspace-browser';

/** Shape returned by POST /api/redis/command. */
interface CommandResponse {
  argv: string[];
  result: unknown;
  durationMs: number;
}

/** POST /api/redis/key/write echoes the surviving PTTL. */
interface WriteResponse {
  key: string;
  ttlMs: number;
}

/** The route caps `limit` at 5000, which is therefore the largest editable value. */
const MAX_WINDOW = 5000;
/** U+FFFD: what a non-UTF-8 byte becomes on the way here. Its presence means the
 *  decoded string is lossy and must never be written back. */
const REPLACEMENT_CHAR = '\uFFFD';
const STRING_WINDOW = MAX_WINDOW;
const PAGE_SIZES = [50, 100, 250, 500, 1000] as const;

export interface ValueEditorProps {
  connectionId: string;
  db: number | undefined;
  keyName: string | null;
  /** Selection follow-up after a rename (new name) or a delete (null). */
  onKeyChanged: (nextKey: string | null) => void;
  /** Ask the keyspace browser to re-scan. */
  onKeyspaceChanged: () => void;
}

interface Loaded {
  value: TypedValue;
  ttlMs: number;
  offset: number;
  limit: number;
  /** STRLEN, for strings only — the only exact way to know a window is whole. */
  byteLength?: number;
}

export function ValueEditor({ connectionId, db, keyName, onKeyChanged, onKeyspaceChanged }: ValueEditorProps) {
  // One identity for "what we are looking at": a different key, database or
  // connection resets the window and the draft.
  const identity = `${connectionId}\u0000${db ?? ''}\u0000${keyName ?? ''}`;
  const [view, setView] = React.useState({ identity, offset: 0, limit: 100 });
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [draft, setDraft] = React.useState<TypedValue | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; hint?: string } | null>(null);
  const [ttlDraft, setTtlDraft] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [renameTo, setRenameTo] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const runId = React.useRef(0);

  // Reset during render rather than in an effect: an effect would let one stale
  // request (old offset, new key) leave for the server before it ran.
  if (view.identity !== identity) {
    setView({ identity, offset: 0, limit: 100 });
    setLoaded(null);
    setDraft(null);
    setError(null);
    setTtlDraft('');
  }

  const load = React.useCallback(
    async (offset: number, limit: number) => {
      if (!keyName) return;
      const token = ++runId.current;
      setLoading(true);
      setError(null);
      try {
        let res = await readKey(connectionId, keyName, db, offset, limit);
        if (token !== runId.current) return;

        let usedLimit = limit;
        let byteLength: number | undefined;
        if (res.value.type === 'string') {
          // GETRANGE windows *bytes* while JS counts UTF-16 units, so the length
          // of what came back can never prove the window covered the value.
          // STRLEN can, and it is O(1).
          byteLength = await strlen(connectionId, keyName, db);
          if (token !== runId.current) return;
          // The collection page size counts *elements*, which is the wrong unit
          // for a string: re-read it with the byte window instead of showing a
          // 100-byte sliver of a JSON blob.
          if (limit < STRING_WINDOW && (byteLength === undefined || byteLength > limit)) {
            res = await readKey(connectionId, keyName, db, offset, STRING_WINDOW);
            if (token !== runId.current) return;
            usedLimit = STRING_WINDOW;
          }
        }
        setLoaded({ value: res.value, ttlMs: res.ttlMs, offset, limit: usedLimit, byteLength });
        setDraft(clone(res.value));
      } catch (err) {
        if (token !== runId.current) return;
        setError(describeError(err));
        setLoaded(null);
        setDraft(null);
      } finally {
        if (token === runId.current) setLoading(false);
      }
    },
    [connectionId, db, keyName],
  );

  React.useEffect(() => {
    void load(view.offset, view.limit);
  }, [load, view]);

  const dirty = React.useMemo(
    () => draft !== null && loaded !== null && JSON.stringify(draft) !== JSON.stringify(loaded.value),
    [draft, loaded],
  );

  if (!keyName) {
    return (
      <EmptyState
        icon={<Tag className="size-5" />}
        title="No key selected"
        description="Pick a key in the keyspace browser to view and edit its value."
      />
    );
  }

  if (loading && !loaded) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-[var(--fg-muted)]">
        <Spinner /> Reading {keyName}…
      </div>
    );
  }

  if (error && !loaded) {
    return (
      <div className="p-3">
        <ErrorBox title="Could not read the key" message={error.message} hint={error.hint} />
        <Button className="mt-2" size="xs" onClick={() => void load(view.offset, view.limit)}>
          Retry
        </Button>
      </div>
    );
  }

  if (!loaded || !draft) return null;

  if (loaded.value.type === 'none') {
    return (
      <EmptyState
        icon={<Tag className="size-5" />}
        title="This key no longer exists"
        description={`${keyName} was expired or deleted since the keyspace was scanned.`}
        action={
          <Button
            size="sm"
            onClick={() => {
              onKeyspaceChanged();
              onKeyChanged(null);
            }}
          >
            Back to the keyspace
          </Button>
        }
      />
    );
  }

  const state = completeness(loaded);
  const readOnlyValue = !state.complete;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { connectionId, key: keyName, value: draft };
      // DEL + rebuild drops the expiry, so an expiring key must be told to keep
      // it. `ttlMs` has a minimum of 1 on the route, hence the > 0 test.
      if (loaded.ttlMs > 0) body.ttlMs = loaded.ttlMs;
      if (db !== undefined) body.db = db;
      await api.post<WriteResponse>('/api/redis/key/write', body);
      toast.success(`${keyName} written`);
      onKeyspaceChanged();
      await load(view.offset, view.limit);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const runCommand = async (argv: string[]): Promise<unknown> => {
    const body: Record<string, unknown> = { connectionId, argv };
    if (db !== undefined) body.db = db;
    const res = await api.post<CommandResponse>('/api/redis/command', body);
    return res.result;
  };

  const applyTtl = async () => {
    const ms = parseDuration(ttlDraft);
    if (ms === null || ms < 1) {
      toast.error('Enter a duration like 30s, 15m, 2h or 7d');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // PEXPIRE rather than a rewrite: re-writing a 10M element list to change
      // its expiry would be absurd.
      const res = await runCommand(['pexpire', keyName, String(Math.round(ms))]);
      // PEXPIRE answers 0 when there was no such key to expire.
      const applied = typeof res === 'number' ? res : typeof res === 'string' ? Number(res) : NaN;
      if (applied === 0) toast.error('Redis refused the expiry (the key may be gone)');
      else toast.success(`Expires in ${formatDurationMs(ms)}`);
      setTtlDraft('');
      onKeyspaceChanged();
      await load(view.offset, view.limit);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const persist = async () => {
    setBusy(true);
    setError(null);
    try {
      await runCommand(['persist', keyName]);
      toast.success('Expiry removed');
      onKeyspaceChanged();
      await load(view.offset, view.limit);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const target = renameTo.trim();
    if (!target || target === keyName) return;
    setBusy(true);
    setError(null);
    try {
      await runCommand(['rename', keyName, target]);
      setRenaming(false);
      toast.success(`Renamed to ${target}`);
      onKeyspaceChanged();
      onKeyChanged(target);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      // Writing `none` is the documented delete on this route: Redis has no
      // empty value, so an empty write means "remove the key".
      const body: Record<string, unknown> = { connectionId, key: keyName, value: { type: 'none' } };
      if (db !== undefined) body.db = db;
      await api.post<WriteResponse>('/api/redis/key/write', body);
      toast.success(`${keyName} deleted`);
      onKeyspaceChanged();
      onKeyChanged(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const ttl = formatTtl(loaded.ttlMs);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar>
        <TypeBadge type={loaded.value.type} />
        <span className="mono min-w-0 flex-1 truncate text-[var(--fg)]" title={keyName}>
          {keyName}
        </span>
        <Button
          size="xs"
          variant="ghost"
          title="Copy key name"
          onClick={() =>
            void navigator.clipboard
              .writeText(keyName)
              .then(() => toast.success('Key copied'))
              .catch(() => toast.error('Clipboard is not available'))
          }
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="Reload"
          disabled={loading || busy}
          onClick={() => void load(view.offset, view.limit)}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Undo2 className="size-3.5" />}
          disabled={!dirty || busy}
          onClick={() => setDraft(clone(loaded.value))}
        >
          Revert
        </Button>
        <Button
          size="xs"
          variant="primary"
          icon={<Save className="size-3.5" />}
          loading={busy}
          disabled={!dirty || readOnlyValue}
          title={readOnlyValue ? state.reason : 'Replace the key with the edited value'}
          onClick={() => void save()}
        >
          Save
        </Button>
        <Button
          size="xs"
          variant="ghost"
          icon={<Trash2 className="size-3.5" />}
          disabled={busy}
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </Button>
      </Toolbar>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--fg-muted)]">
        <Clock className="size-3" />
        <span className={ttl.tone === 'live' ? 'text-[var(--warn)]' : undefined}>TTL {ttl.text}</span>
        <Input
          className="h-6 w-28"
          placeholder="30s · 15m · 2h"
          value={ttlDraft}
          onChange={(e) => setTtlDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void applyTtl();
          }}
        />
        <Button size="xs" disabled={busy || ttlDraft.trim() === ''} onClick={() => void applyTtl()}>
          Set
        </Button>
        <Button size="xs" variant="ghost" disabled={busy || loaded.ttlMs < 0} onClick={() => void persist()}>
          Persist
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setRenameTo(keyName);
            setRenaming(true);
          }}
        >
          Rename
        </Button>
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          {state.total !== null && <span>{formatCount(state.total)} elements</span>}
          {loaded.byteLength !== undefined && <span>{formatCount(loaded.byteLength)} bytes</span>}
          {db !== undefined && <Badge tone="accent">db {db}</Badge>}
        </span>
      </div>

      {error && (
        <div className="p-2">
          <ErrorBox message={error.message} hint={error.hint} />
        </div>
      )}

      {readOnlyValue && (
        <p className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1 text-[11px] text-[var(--warn)]">
          {state.reason}
          {state.canLoadAll && (
            <Button
              size="xs"
              variant="ghost"
              className="ml-2 h-5"
              onClick={() => setView({ identity, offset: 0, limit: Math.min(MAX_WINDOW, state.total ?? MAX_WINDOW) })}
            >
              Load all {formatCount(state.total ?? 0)} for editing
            </Button>
          )}
        </p>
      )}

      {loaded.value.type === 'stream' && (
        <p className="shrink-0 border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1 text-[11px] text-[var(--warn)]">
          Saving rewrites the stream from scratch: consumer groups and their pending entries do not survive.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <ValueBody value={draft} editable={!readOnlyValue} offset={loaded.offset} onChange={setDraft} />
      </div>

      {state.total !== null && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)]">
          <span className="tabular-nums">
            {formatCount(loaded.offset + 1)}–{formatCount(loaded.offset + state.loaded)} of {formatCount(state.total)}
          </span>
          <Select
            className="ml-auto h-6 w-20"
            value={String(view.limit)}
            disabled={dirty}
            title={dirty ? 'Save or revert first' : 'Elements per window'}
            onChange={(e) => setView({ identity, offset: 0, limit: Number(e.target.value) })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
          <Button
            size="xs"
            variant="ghost"
            disabled={dirty || loaded.offset === 0}
            onClick={() => setView((w) => ({ ...w, offset: Math.max(0, w.offset - w.limit) }))}
          >
            <ChevronLeft className="size-3" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={dirty || loaded.offset + state.loaded >= state.total}
            onClick={() => setView((w) => ({ ...w, offset: w.offset + w.limit }))}
          >
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      {loaded.value.type === 'string' && loaded.byteLength !== undefined && loaded.byteLength > STRING_WINDOW && (
        <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)]">
          <span className="tabular-nums">
            bytes {formatCount(loaded.offset)}–{formatCount(Math.min(loaded.byteLength, loaded.offset + STRING_WINDOW))}{' '}
            of {formatCount(loaded.byteLength)}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={loaded.offset === 0}
            onClick={() => setView({ identity, offset: Math.max(0, loaded.offset - STRING_WINDOW), limit: STRING_WINDOW })}
          >
            <ChevronLeft className="size-3" />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={loaded.offset + STRING_WINDOW >= loaded.byteLength}
            onClick={() => setView({ identity, offset: loaded.offset + STRING_WINDOW, limit: STRING_WINDOW })}
          >
            <ChevronRight className="size-3" />
          </Button>
        </div>
      )}

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename key"
        width="sm"
        footer={
          <>
            <Button onClick={() => setRenaming(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void rename()}>
              Rename
            </Button>
          </>
        }
      >
        <Field
          label="New key name"
          hint="RENAME overwrites the target if it already exists, and keeps the TTL of the source key."
        >
          <Input
            className="mono"
            value={renameTo}
            autoFocus
            spellCheck={false}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void rename();
            }}
          />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title="Delete key"
        confirmWord={keyName}
        message={
          <span>
            Delete <span className="mono">{keyName}</span> from this database? This cannot be undone.
          </span>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completeness: what may be saved
// ---------------------------------------------------------------------------

interface Completeness {
  complete: boolean;
  reason: string;
  /** Element count for collections, null for strings. */
  total: number | null;
  loaded: number;
  canLoadAll: boolean;
}

function completeness(loaded: Loaded): Completeness {
  const value = loaded.value;
  if (value.type === 'string') {
    const bytes = loaded.byteLength;
    if (value.value.includes(REPLACEMENT_CHAR)) {
      return {
        complete: false,
        reason: 'This value is not valid UTF-8. It is shown decoded, and saving it would corrupt the bytes.',
        total: null,
        loaded: value.value.length,
        canLoadAll: false,
      };
    }
    if (bytes === undefined) {
      return {
        complete: false,
        reason: 'STRLEN was refused, so the window cannot be proven complete and saving is disabled.',
        total: null,
        loaded: value.value.length,
        canLoadAll: false,
      };
    }
    if (loaded.offset === 0 && bytes <= loaded.limit) {
      return { complete: true, reason: '', total: null, loaded: value.value.length, canLoadAll: false };
    }
    return {
      complete: false,
      reason: `Showing a ${formatCount(loaded.limit)} byte window of a ${formatCount(bytes)} byte value — too large to edit here.`,
      total: null,
      loaded: value.value.length,
      canLoadAll: false,
    };
  }

  const { total, loaded: count } = elementCounts(value);
  if (loaded.offset === 0 && count >= total) {
    return { complete: true, reason: '', total, loaded: count, canLoadAll: false };
  }
  return {
    complete: false,
    // Spelled out because "why is Save greyed out" is otherwise a mystery: a
    // write replaces the key, so a partial value would delete the remainder.
    reason: `Showing ${formatCount(count)} of ${formatCount(total)} elements. A write replaces the whole key, so editing needs the whole value loaded.`,
    total,
    loaded: count,
    canLoadAll: total <= MAX_WINDOW,
  };
}

function elementCounts(value: TypedValue): { total: number; loaded: number } {
  switch (value.type) {
    case 'list':
      return { total: value.total, loaded: value.items.length };
    case 'set':
      return { total: value.total, loaded: value.members.length };
    case 'zset':
      return { total: value.total, loaded: value.members.length };
    case 'hash':
      return { total: value.total, loaded: value.fields.length };
    case 'stream':
      return { total: value.total, loaded: value.entries.length };
    default:
      return { total: 0, loaded: 0 };
  }
}

// ---------------------------------------------------------------------------
// Per-type editors
// ---------------------------------------------------------------------------

function ValueBody({
  value,
  editable,
  offset,
  onChange,
}: {
  value: TypedValue;
  editable: boolean;
  /** Window position, so a list shows its real indices rather than 0..n. */
  offset: number;
  onChange: (next: TypedValue) => void;
}) {
  switch (value.type) {
    case 'string':
      return (
        <div className="h-full p-2">
          <Textarea
            className="h-full min-h-[8rem] w-full"
            value={value.value}
            readOnly={!editable}
            spellCheck={false}
            onChange={(e) => onChange({ type: 'string', value: e.target.value })}
          />
        </div>
      );

    case 'list':
      return (
        <ItemRows
          items={value.items}
          editable={editable}
          ordered
          startIndex={offset}
          columnLabel="Element"
          onChange={(items) => onChange({ type: 'list', items, total: items.length })}
        />
      );

    case 'set':
      return (
        <ItemRows
          items={value.members}
          editable={editable}
          ordered={false}
          startIndex={offset}
          columnLabel="Member"
          hint="A set has no order and no duplicates; repeated members collapse on save."
          onChange={(members) => onChange({ type: 'set', members, total: members.length })}
        />
      );

    case 'zset':
      return (
        <PairRows
          rows={value.members.map((m) => ({ left: m.score, right: m.member }))}
          editable={editable}
          leftLabel="Score"
          rightLabel="Member"
          leftClassName="w-40"
          leftPlaceholder="0"
          hint="Scores travel as text so a 17-digit score is not rounded; inf, -inf and nan are accepted."
          onChange={(rows) =>
            onChange({
              type: 'zset',
              members: rows.map((r) => ({ score: r.left, member: r.right })),
              total: rows.length,
            })
          }
          newRow={{ left: '0', right: '' }}
        />
      );

    case 'hash':
      return (
        <PairRows
          rows={value.fields.map((f) => ({ left: f.field, right: f.value }))}
          editable={editable}
          leftLabel="Field"
          rightLabel="Value"
          leftClassName="w-56"
          leftPlaceholder="field"
          onChange={(rows) =>
            onChange({ type: 'hash', fields: rows.map((r) => ({ field: r.left, value: r.right })), total: rows.length })
          }
          newRow={{ left: '', right: '' }}
        />
      );

    case 'stream':
      return (
        <StreamRows
          entries={value.entries}
          editable={editable}
          onChange={(entries) => onChange({ type: 'stream', entries, total: entries.length })}
        />
      );

    case 'none':
      return null;
  }
}

function RowShell({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col">
      {hint && <p className="px-2 py-1 text-[10px] text-[var(--fg-subtle)]">{hint}</p>}
      {children}
    </div>
  );
}

function ItemRows({
  items,
  editable,
  ordered,
  startIndex,
  columnLabel,
  hint,
  onChange,
}: {
  items: string[];
  editable: boolean;
  ordered: boolean;
  startIndex: number;
  columnLabel: string;
  hint?: string;
  onChange: (next: string[]) => void;
}) {
  const set = (index: number, text: string) => onChange(items.map((v, i) => (i === index ? text : v)));
  const removeAt = (index: number) => onChange(items.filter((_, i) => i !== index));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = items.slice();
    const [row] = next.splice(index, 1);
    next.splice(target, 0, row);
    onChange(next);
  };

  return (
    <RowShell hint={hint}>
      <table className="w-full table-fixed text-xs">
        <thead className="bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
          <tr>
            <th className="w-14 px-2 py-1 text-right font-medium">#</th>
            <th className="px-2 py-1 text-left font-medium">{columnLabel}</th>
            <th className="w-24 px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index} className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
              <td className="px-2 py-0.5 text-right tabular-nums text-[var(--fg-subtle)]">{startIndex + index}</td>
              <td className="px-1 py-0.5">
                <Input
                  className="mono h-6"
                  value={item}
                  readOnly={!editable}
                  spellCheck={false}
                  onChange={(e) => set(index, e.target.value)}
                />
              </td>
              <td className="px-1 py-0.5">
                <div className="flex items-center justify-end gap-0.5">
                  {ordered && (
                    <>
                      <Button size="xs" variant="ghost" disabled={!editable || index === 0} title="Move up" onClick={() => move(index, -1)}>
                        ↑
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!editable || index === items.length - 1}
                        title="Move down"
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                    </>
                  )}
                  <Button size="xs" variant="ghost" disabled={!editable} title="Remove" onClick={() => removeAt(index)}>
                    <X className="size-3" />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-2">
        <Button size="xs" icon={<Plus className="size-3" />} disabled={!editable} onClick={() => onChange([...items, ''])}>
          Add {columnLabel.toLowerCase()}
        </Button>
      </div>
    </RowShell>
  );
}

interface Pair {
  left: string;
  right: string;
}

function PairRows({
  rows,
  editable,
  leftLabel,
  rightLabel,
  leftClassName,
  leftPlaceholder,
  hint,
  newRow,
  onChange,
}: {
  rows: Pair[];
  editable: boolean;
  leftLabel: string;
  rightLabel: string;
  leftClassName?: string;
  leftPlaceholder?: string;
  hint?: string;
  newRow: Pair;
  onChange: (next: Pair[]) => void;
}) {
  const set = (index: number, patch: Partial<Pair>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <RowShell hint={hint}>
      <table className="w-full text-xs">
        <thead className="bg-[var(--grid-header)] text-[10px] uppercase tracking-wide text-[var(--fg-muted)]">
          <tr>
            <th className={cn('px-2 py-1 text-left font-medium', leftClassName)}>{leftLabel}</th>
            <th className="px-2 py-1 text-left font-medium">{rightLabel}</th>
            <th className="w-10 px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-[var(--border)] last:border-0 even:bg-[var(--row-alt)]">
              <td className="px-1 py-0.5">
                <Input
                  className="mono h-6"
                  value={row.left}
                  placeholder={leftPlaceholder}
                  readOnly={!editable}
                  spellCheck={false}
                  onChange={(e) => set(index, { left: e.target.value })}
                />
              </td>
              <td className="px-1 py-0.5">
                <Input
                  className="mono h-6"
                  value={row.right}
                  readOnly={!editable}
                  spellCheck={false}
                  onChange={(e) => set(index, { right: e.target.value })}
                />
              </td>
              <td className="px-1 py-0.5 text-right">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!editable}
                  title="Remove"
                  onClick={() => onChange(rows.filter((_, i) => i !== index))}
                >
                  <X className="size-3" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-2">
        <Button size="xs" icon={<Plus className="size-3" />} disabled={!editable} onClick={() => onChange([...rows, { ...newRow }])}>
          Add row
        </Button>
      </div>
    </RowShell>
  );
}

function StreamRows({
  entries,
  editable,
  onChange,
}: {
  entries: { id: string; fields: Record<string, string> }[];
  editable: boolean;
  onChange: (next: { id: string; fields: Record<string, string> }[]) => void;
}) {
  const setEntry = (index: number, patch: Partial<{ id: string; fields: Record<string, string> }>) =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));

  return (
    <RowShell hint="Entry ids are preserved on save; “*” asks the server for the next id.">
      <div className="flex flex-col">
        {entries.map((entry, index) => (
          <div key={index} className="border-b border-[var(--border)]">
            <div className="flex items-center gap-2 bg-[var(--bg-subtle)] px-2 py-1">
              <Input
                className="mono h-6 w-56"
                value={entry.id}
                readOnly={!editable}
                spellCheck={false}
                onChange={(e) => setEntry(index, { id: e.target.value })}
              />
              <span className="text-[10px] text-[var(--fg-subtle)]">
                {Object.keys(entry.fields).length} field{Object.keys(entry.fields).length === 1 ? '' : 's'}
              </span>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                disabled={!editable}
                title="Remove entry"
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
              >
                <X className="size-3" />
              </Button>
            </div>
            <FieldMapRows
              fields={entry.fields}
              editable={editable}
              onChange={(fields) => setEntry(index, { fields })}
            />
          </div>
        ))}
      </div>
      <div className="p-2">
        <Button
          size="xs"
          icon={<Plus className="size-3" />}
          disabled={!editable}
          onClick={() => onChange([...entries, { id: '*', fields: {} }])}
        >
          Add entry
        </Button>
      </div>
    </RowShell>
  );
}

function FieldMapRows({
  fields,
  editable,
  onChange,
}: {
  fields: Record<string, string>;
  editable: boolean;
  onChange: (next: Record<string, string>) => void;
}) {
  // Edited as an ordered pair list so renaming a field does not reorder or
  // collide with itself mid-keystroke.
  const pairs = Object.entries(fields);
  const emit = (next: [string, string][]) => onChange(Object.fromEntries(next));

  return (
    <table className="w-full text-xs">
      <tbody>
        {pairs.map(([name, value], index) => (
          <tr key={index} className="border-t border-[var(--border)]">
            <td className="w-56 px-1 py-0.5">
              <Input
                className="mono h-6"
                value={name}
                readOnly={!editable}
                spellCheck={false}
                onChange={(e) => emit(pairs.map((p, i): [string, string] => (i === index ? [e.target.value, p[1]] : p)))}
              />
            </td>
            <td className="px-1 py-0.5">
              <Input
                className="mono h-6"
                value={value}
                readOnly={!editable}
                spellCheck={false}
                onChange={(e) => emit(pairs.map((p, i): [string, string] => (i === index ? [p[0], e.target.value] : p)))}
              />
            </td>
            <td className="w-10 px-1 py-0.5 text-right">
              <Button
                size="xs"
                variant="ghost"
                disabled={!editable}
                title="Remove field"
                onClick={() => emit(pairs.filter((_, i) => i !== index))}
              >
                <X className="size-3" />
              </Button>
            </td>
          </tr>
        ))}
        <tr className="border-t border-[var(--border)]">
          <td colSpan={3} className="px-1 py-0.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={!editable}
              onClick={() => emit([...pairs, [`field${pairs.length + 1}`, ''] as [string, string]])}
            >
              Add field
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readKey(
  connectionId: string,
  key: string,
  db: number | undefined,
  offset: number,
  limit: number,
): Promise<RedisKeyResponse> {
  const body: RedisKeyRequest & { db?: number } = { connectionId, key, offset, limit };
  if (db !== undefined) body.db = db;
  return api.post<RedisKeyResponse>('/api/redis/key', body);
}

async function strlen(connectionId: string, key: string, db: number | undefined): Promise<number | undefined> {
  try {
    const body: Record<string, unknown> = { connectionId, argv: ['strlen', key] };
    if (db !== undefined) body.db = db;
    const res = await api.post<CommandResponse>('/api/redis/command', body);
    if (typeof res.result === 'number') return res.result;
    if (typeof res.result === 'string' && /^\d+$/.test(res.result)) return Number(res.result);
    return undefined;
  } catch {
    // A refused STRLEN is not an error worth showing: it only means the value
    // stays read-only, which `completeness()` explains in place.
    return undefined;
  }
}

function clone(value: TypedValue): TypedValue {
  return JSON.parse(JSON.stringify(value)) as TypedValue;
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Human durations: `90` (bare numbers are seconds, as EXPIRE reads them),
 * `500ms`, `15m`, `2h30m`, `7d`. Returns milliseconds, or null when the whole
 * string was not consumed — a typo must not silently become a wrong expiry.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (text === '') return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;

  const pattern = /(\d+(?:\.\d+)?)\s*(ms|sec|s|min|m|hr|h|d|w)/g;
  let total = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const unit = DURATION_UNITS[match[2]];
    if (unit === undefined) return null;
    total += Number(match[1]) * unit;
    consumed += match[0].length;
  }
  const stripped = text.replace(/\s+/g, '');
  if (total === 0 || consumed < stripped.length) return null;
  return total;
}

function describeError(err: unknown): { message: string; hint?: string } {
  if (err instanceof ApiRequestError) {
    if (err.code === 'READONLY_CONNECTION') {
      return { message: err.message, hint: err.hint ?? 'This connection is marked read-only.' };
    }
    return { message: err.message, hint: err.hint };
  }
  return { message: err instanceof Error ? err.message : 'Unexpected error' };
}
