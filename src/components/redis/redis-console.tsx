'use client';

/**
 * Redis CLI console (PLAN M4).
 *
 * A real console, not a query box: the typed line is split the way redis-cli
 * splits it (quotes, escapes, `\xHH`), sent as argv to POST /api/redis/command,
 * and the RESP reply is rendered in redis-cli's own shape — nested arrays with
 * `1)` indices, `(integer)`, `(nil)`, `(empty array)`.
 *
 * Two refusals get first-class rendering rather than a generic red line, because
 * both are states the user has to *understand* to get on with their work:
 *   - 403 READONLY_CONNECTION — the client-side blocklist a read-only Redis
 *     connection enforces (PLAN §8.5; Redis has no server-side read-only mode).
 *   - 409 CONNECTION_MODE — MONITOR/SUBSCRIBE/MULTI need a dedicated socket and
 *     live in the Monitor panel instead.
 */

import * as React from 'react';
import { Ban, ChevronRight, Eraser, Radio } from 'lucide-react';
import { api, ApiRequestError } from '../../lib/api-client';
import type { RedisCommandRequest } from '../../lib/api-types';
import { Badge, Button, Input, Toolbar, cn } from '../ui/primitives';

/** Shape returned by POST /api/redis/command. */
interface CommandResponse {
  argv: string[];
  result: unknown;
  durationMs: number;
}

interface ConsoleEntry {
  id: number;
  argv: string[];
  status: 'pending' | 'ok' | 'error' | 'local';
  value?: unknown;
  durationMs?: number;
  error?: { message: string; code?: string; hint?: string; status?: number };
  note?: string;
}

/** Console scrollback cap — an unbounded log is a memory leak with a prompt. */
const MAX_ENTRIES = 500;
const MAX_HISTORY = 200;

/**
 * Commands whose effect the keyspace browser should see. Anything not in the
 * read set counts as a mutation, so an unknown/new command errs towards
 * refreshing rather than towards a stale list.
 */
const READ_ONLY_COMMANDS = new Set([
  'get', 'mget', 'strlen', 'getrange', 'exists', 'ttl', 'pttl', 'type', 'keys', 'scan', 'randomkey', 'dbsize',
  'llen', 'lrange', 'lindex', 'lpos', 'scard', 'smembers', 'sismember', 'srandmember', 'sscan', 'sinter', 'sunion',
  'sdiff', 'zcard', 'zcount', 'zscore', 'zrange', 'zrevrange', 'zrangebyscore', 'zrank', 'zscan', 'hget', 'hmget',
  'hgetall', 'hkeys', 'hvals', 'hlen', 'hexists', 'hscan', 'xlen', 'xrange', 'xrevrange', 'xinfo', 'object',
  'memory', 'info', 'config', 'client', 'command', 'ping', 'echo', 'time', 'lolwut', 'select', 'auth', 'debug',
  'latency', 'slowlog', 'acl', 'cluster', 'dump', 'lastsave', 'role', 'wait', 'bitcount', 'getbit', 'sintercard',
]);

export interface RedisConsoleProps {
  connectionId: string;
  db: number | undefined;
  /** Fired after a command that may have changed the keyspace. */
  onKeyspaceChanged: () => void;
}

export function RedisConsole({ connectionId, db, onKeyspaceChanged }: RedisConsoleProps) {
  const [line, setLine] = React.useState('');
  const [entries, setEntries] = React.useState<ConsoleEntry[]>([]);
  const [history, setHistory] = React.useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState<number | null>(null);
  const [pending, setPending] = React.useState(false);
  const draftRef = React.useRef('');
  const nextId = React.useRef(1);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const append = React.useCallback((entry: ConsoleEntry) => {
    setEntries((prev) => {
      const next = prev.concat(entry);
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }, []);

  const patch = React.useCallback((id: number, changes: Partial<ConsoleEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)));
  }, []);

  // Follow the tail; the console is a log, and a log that does not follow is a
  // log you have to chase.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const submit = async () => {
    const text = line.trim();
    if (text === '' || pending) return;

    setHistory((prev) => {
      const next = prev[prev.length - 1] === text ? prev : prev.concat(text);
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
    setHistoryIndex(null);
    draftRef.current = '';
    setLine('');

    // redis-cli's own client-side command: never leaves the browser.
    if (/^clear$/i.test(text)) {
      setEntries([]);
      return;
    }

    const parsed = tokenize(text);
    if (parsed.error) {
      append({ id: nextId.current++, argv: [text], status: 'error', error: { message: parsed.error } });
      return;
    }

    const id = nextId.current++;
    append({ id, argv: parsed.argv, status: 'pending' });
    setPending(true);
    try {
      const body: RedisCommandRequest & { db?: number } = { connectionId, argv: parsed.argv };
      if (db !== undefined) body.db = db;
      const res = await api.post<CommandResponse>('/api/redis/command', body);
      patch(id, { status: 'ok', value: res.result, durationMs: res.durationMs });
      if (!READ_ONLY_COMMANDS.has(parsed.argv[0].toLowerCase())) onKeyspaceChanged();
    } catch (err) {
      if (err instanceof ApiRequestError) {
        patch(id, {
          status: 'error',
          error: { message: err.message, code: err.code, hint: err.hint, status: err.status },
        });
      } else {
        patch(id, { status: 'error', error: { message: err instanceof Error ? err.message : 'Command failed' } });
      }
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setEntries([]);
      return;
    }
    if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      e.preventDefault();
      // The half-typed line is parked on the first step back and restored when
      // the user walks past the end of history again.
      if (historyIndex === null) draftRef.current = line;
      const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index);
      setLine(history[index]);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIndex === null) return;
      e.preventDefault();
      const index = historyIndex + 1;
      if (index >= history.length) {
        setHistoryIndex(null);
        setLine(draftRef.current);
      } else {
        setHistoryIndex(index);
        setLine(history[index]);
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <Toolbar>
        <Radio className="size-3.5 text-[var(--fg-muted)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-muted)]">Console</span>
        {db !== undefined && <Badge tone="accent">db {db}</Badge>}
        <span className="text-[10px] text-[var(--fg-subtle)]">
          MONITOR, SUBSCRIBE and MULTI need their own socket — they live in the Monitor panel.
        </span>
        <Button size="xs" variant="ghost" className="ml-auto" icon={<Eraser className="size-3.5" />} onClick={() => setEntries([])}>
          Clear
        </Button>
      </Toolbar>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-2 py-1">
        {entries.length === 0 && (
          <p className="mono py-2 text-[var(--fg-subtle)]">
            Type a command, e.g. <span className="text-[var(--fg-muted)]">GET user:1</span> or{' '}
            <span className="text-[var(--fg-muted)]">HGETALL session:abc</span>. ↑/↓ walks history, Ctrl-L clears.
          </p>
        )}
        {entries.map((entry) => (
          <EntryView key={entry.id} entry={entry} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-[var(--border)] bg-[var(--bg-subtle)] px-2 py-1">
        <span className="mono shrink-0 text-[var(--accent)]">redis{db !== undefined ? `[${db}]` : ''}&gt;</span>
        <Input
          ref={inputRef}
          className="mono h-7 border-transparent bg-transparent focus-visible:border-[var(--border)]"
          value={line}
          placeholder="command"
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          // Deliberately not disabled while a command is in flight: a disabled
          // input drops focus, and you would have to click back into the console
          // after every command.
          onChange={(e) => {
            setLine(e.target.value);
            setHistoryIndex(null);
          }}
          onKeyDown={onKeyDown}
        />
        <Button size="xs" variant="primary" loading={pending} onClick={() => void submit()}>
          Run
        </Button>
      </div>
    </div>
  );
}

function EntryView({ entry }: { entry: ConsoleEntry }) {
  return (
    <div className="border-b border-[var(--border)] py-1 last:border-0">
      <div className="mono flex items-start gap-1">
        <ChevronRight className="mt-0.5 size-3 shrink-0 text-[var(--accent)]" />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[var(--fg)]">{formatArgv(entry.argv)}</span>
        {entry.durationMs !== undefined && (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--fg-subtle)]">
            {entry.durationMs < 1 ? '<1' : Math.round(entry.durationMs)} ms
          </span>
        )}
      </div>

      <div className="mono pl-4">
        {entry.status === 'pending' && <span className="text-[var(--fg-subtle)]">…</span>}
        {entry.status === 'ok' && <Reply value={entry.value} />}
        {entry.status === 'error' && entry.error && <ErrorReply error={entry.error} />}
      </div>
    </div>
  );
}

function ErrorReply({ error }: { error: NonNullable<ConsoleEntry['error']> }) {
  const blocked = error.code === 'READONLY_CONNECTION';
  const wrongMode = error.code === 'CONNECTION_MODE';

  if (blocked || wrongMode) {
    return (
      <div
        className={cn(
          'my-1 flex items-start gap-2 rounded border p-2',
          blocked
            ? 'border-[var(--danger)]/40 bg-[var(--danger-bg)]'
            : 'border-[var(--warn)]/40 bg-[var(--warn-bg)]',
        )}
      >
        <Ban className={cn('mt-0.5 size-3.5 shrink-0', blocked ? 'text-[var(--danger)]' : 'text-[var(--warn)]')} />
        <div className="min-w-0">
          <p className={cn('text-[11px] font-semibold', blocked ? 'text-[var(--danger)]' : 'text-[var(--warn)]')}>
            {blocked ? 'Blocked by the read-only blocklist' : 'Not available on this connection'}
          </p>
          <p className="whitespace-pre-wrap break-words text-[var(--fg)]">{error.message}</p>
          {error.hint && <p className="mt-1 text-[11px] text-[var(--fg-muted)]">{error.hint}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="text-[var(--danger)]">
      <span className="whitespace-pre-wrap break-words">
        (error) {error.code && error.code !== 'DB_ERROR' ? `${error.code} ` : ''}
        {error.message}
      </span>
      {error.hint && <p className="text-[11px] text-[var(--fg-muted)]">{error.hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RESP rendering
// ---------------------------------------------------------------------------

function Reply({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-[var(--null-fg)]">(nil)</span>;

  if (typeof value === 'boolean') return <span className="text-[var(--accent)]">({value ? 'true' : 'false'})</span>;

  if (typeof value === 'number' || typeof value === 'bigint') {
    return <span className="text-[var(--accent)]">(integer) {String(value)}</span>;
  }

  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap break-all text-[var(--fg)]">&quot;{value}&quot;</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-[var(--fg-subtle)]">(empty array)</span>;
    return (
      <div className="flex flex-col">
        {value.map((item, index) => (
          <div key={index} className="flex gap-1.5">
            <span className="shrink-0 tabular-nums text-[var(--fg-subtle)]">{index + 1})</span>
            <div className="min-w-0 flex-1">
              <Reply value={item} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === 'object') {
    const buffer = asBuffer(value);
    if (buffer) {
      return (
        <span className="text-[var(--fg-muted)]">
          [{buffer.length} bytes] {hexPreview(buffer)}
        </span>
      );
    }
    // RESP3 maps arrive as plain objects (CONFIG GET, XINFO STREAM, …).
    const pairs = Object.entries(value as Record<string, unknown>);
    if (pairs.length === 0) return <span className="text-[var(--fg-subtle)]">(empty map)</span>;
    return (
      <div className="flex flex-col">
        {pairs.map(([name, item]) => (
          <div key={name} className="flex gap-1.5">
            <span className="shrink-0 text-[var(--fg-muted)]">{name}:</span>
            <div className="min-w-0 flex-1">
              <Reply value={item} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return <span>{String(value)}</span>;
}

/** Node Buffers serialize to `{ type: 'Buffer', data: number[] }` over JSON. */
function asBuffer(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { type?: unknown; data?: unknown };
  if (record.type === 'Buffer' && Array.isArray(record.data)) return record.data as number[];
  return null;
}

function hexPreview(bytes: number[]): string {
  const head = bytes
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return bytes.length > 12 ? `${head} …` : head;
}

// ---------------------------------------------------------------------------
// Line splitting (redis-cli's sdssplitargs, in TypeScript)
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07', '\\': '\\', '"': '"' };

export function tokenize(line: string): { argv: string[]; error?: string } {
  const argv: string[] = [];
  let i = 0;

  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;

    let token = '';
    const quote = line[i] === '"' || line[i] === "'" ? line[i] : '';
    if (quote) i++;
    let closed = !quote;

    while (i < line.length) {
      const ch = line[i];
      if (quote === '"') {
        if (ch === '\\' && i + 1 < line.length) {
          const next = line[i + 1];
          if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            token += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          token += ESCAPES[next] ?? next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          i++;
          closed = true;
          break;
        }
      } else if (quote === "'") {
        // Single quotes are literal apart from \' — same as redis-cli.
        if (ch === '\\' && line[i + 1] === "'") {
          token += "'";
          i += 2;
          continue;
        }
        if (ch === "'") {
          i++;
          closed = true;
          break;
        }
      } else if (/\s/.test(ch)) {
        break;
      }
      token += ch;
      i++;
    }

    if (!closed) return { argv: [], error: 'Unbalanced quotes' };
    // A closing quote must be followed by whitespace, as in redis-cli.
    if (quote && i < line.length && !/\s/.test(line[i])) {
      return { argv: [], error: 'Closing quote must be followed by a space' };
    }
    argv.push(token);
  }

  if (argv.length === 0) return { argv: [], error: 'Empty command' };
  return { argv };
}

/** Echo the command back the way it was parsed, re-quoting anything unusual. */
function formatArgv(argv: string[]): string {
  return argv
    .map((token) => (token === '' || /[\s"']/.test(token) ? JSON.stringify(token) : token))
    .join(' ');
}
