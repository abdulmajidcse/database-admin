'use client';

/**
 * MONITOR + pub/sub streams (PLAN M4, §6 "each needs its own dedicated
 * connection, streamed to the UI over WebSocket with a ring buffer").
 *
 * Both feeds arrive on the shared socket: `redis-monitor` (lines) and
 * `redis-pubsub` (channel + message). Three decisions shape this file:
 *
 *  - MONITOR is opt-in. It makes the server echo every command it executes and
 *    costs a real slice of its throughput, so it starts on an explicit click and
 *    never merely because a panel was opened.
 *  - Incoming lines land in a ref and are flushed to React state on an interval.
 *    A busy Redis emits tens of thousands of lines a second; one setState per
 *    message would melt the renderer.
 *  - The buffer is a hard ring of 2000 lines. Pausing stops ingestion and counts
 *    what was skipped rather than growing without bound behind the scenes.
 */

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Eraser, Funnel, Pause, Play, Radio, Square, X } from 'lucide-react';
import { wsClient } from '../../lib/ws-client';
import type { ServerMessage } from '../../lib/api-types';
import { Badge, Button, Checkbox, Input, Toolbar, cn } from '../ui/primitives';

const RING_CAPACITY = 2000;
const FLUSH_MS = 120;
const ROW_HEIGHT = 18;

export interface MonitorPanelProps {
  connectionId: string;
}

type PanelTab = 'monitor' | 'pubsub';

export function MonitorPanel({ connectionId }: MonitorPanelProps) {
  const [tab, setTab] = React.useState<PanelTab>('monitor');
  const [monitorOn, setMonitorOn] = React.useState(false);
  const [channels, setChannels] = React.useState<string[]>([]);
  const [channelDraft, setChannelDraft] = React.useState('');

  const monitorLog = useLiveLog();
  const pubsubLog = useLiveLog();

  // Both feeds stay subscribed while the other tab is showing: a pub/sub stream
  // that dies because you glanced at MONITOR is worse than useless.
  const monitorPush = monitorLog.push;
  React.useEffect(() => {
    if (!monitorOn) return;
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type === 'redis-monitor' && msg.connectionId === connectionId) monitorPush(msg.lines);
    });
    const unsub = wsClient.subscribe({ channel: 'redis-monitor', connectionId });
    return () => {
      off();
      unsub();
    };
  }, [monitorOn, connectionId, monitorPush]);

  const pubsubPush = pubsubLog.push;
  React.useEffect(() => {
    const off = wsClient.onMessage((msg: ServerMessage) => {
      if (msg.type !== 'redis-pubsub' || msg.connectionId !== connectionId) return;
      pubsubPush([`${stamp()}  ${msg.channel}  ${msg.message}`]);
    });
    return off;
  }, [connectionId, pubsubPush]);

  // Serialized rather than joined: a channel name may contain any byte.
  const channelKey = JSON.stringify(channels);
  const pubsubSubs = React.useRef(new Map<string, () => void>());
  React.useEffect(() => {
    // Reconciled rather than torn down and rebuilt: re-subscribing a channel the
    // user did not touch would drop messages during the gap.
    const list = JSON.parse(channelKey) as string[];
    const live = pubsubSubs.current;
    for (const [name, unsub] of live) {
      if (!list.includes(name)) {
        unsub();
        live.delete(name);
      }
    }
    for (const name of list) {
      if (!live.has(name)) live.set(name, wsClient.subscribe({ channel: 'redis-pubsub', connectionId, arg: name }));
    }
  }, [channelKey, connectionId]);

  React.useEffect(() => {
    const live = pubsubSubs.current;
    return () => {
      for (const unsub of live.values()) unsub();
      live.clear();
    };
  }, [connectionId]);

  const addChannel = () => {
    const name = channelDraft.trim();
    if (name === '') return;
    setChannels((prev) => (prev.includes(name) ? prev : prev.concat(name)));
    setChannelDraft('');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--bg)]">
      <Toolbar>
        <TabButton active={tab === 'monitor'} onClick={() => setTab('monitor')}>
          Monitor
        </TabButton>
        <TabButton active={tab === 'pubsub'} onClick={() => setTab('pubsub')}>
          Pub/Sub
          {channels.length > 0 && <Badge tone="accent" className="ml-1.5">{channels.length}</Badge>}
        </TabButton>

        {tab === 'monitor' ? (
          <>
            <Button
              size="xs"
              variant={monitorOn ? 'danger' : 'primary'}
              className="ml-auto"
              icon={monitorOn ? <Square className="size-3" /> : <Play className="size-3" />}
              onClick={() => setMonitorOn((on) => !on)}
            >
              {monitorOn ? 'Stop' : 'Start MONITOR'}
            </Button>
            {monitorOn && <Badge tone="warn">streaming</Badge>}
          </>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <Input
              className="mono h-6 w-48"
              placeholder="channel, e.g. events"
              value={channelDraft}
              spellCheck={false}
              onChange={(e) => setChannelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addChannel();
              }}
            />
            <Button size="xs" onClick={addChannel} disabled={channelDraft.trim() === ''}>
              Subscribe
            </Button>
          </div>
        )}
      </Toolbar>

      {tab === 'monitor' && !monitorOn && monitorLog.lines.length === 0 && (
        <p className="border-b border-[var(--border)] bg-[var(--warn-bg)] px-2 py-1 text-[11px] text-[var(--warn)]">
          MONITOR streams every command the server executes on a dedicated connection and measurably reduces its
          throughput. Start it when you need it, and stop it when you are done.
        </p>
      )}

      {tab === 'pubsub' && channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-[var(--border)] px-2 py-1">
          {channels.map((channel) => (
            <span
              key={channel}
              className="mono inline-flex items-center gap-1 rounded bg-[var(--bg-active)] px-1.5 py-0.5 text-[11px]"
            >
              {channel}
              <button
                type="button"
                aria-label={`Unsubscribe from ${channel}`}
                title="Unsubscribe"
                className="rounded text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                onClick={() => setChannels((prev) => prev.filter((c) => c !== channel))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Keyed so the two logs do not share one LogView instance — otherwise the
          filter you typed for MONITOR would follow you into pub/sub. */}
      {tab === 'monitor' ? (
        <LogView key="monitor" log={monitorLog} empty={monitorOn ? 'Waiting for commands…' : 'MONITOR is stopped.'} />
      ) : (
        <LogView
          key="pubsub"
          log={pubsubLog}
          empty={channels.length === 0 ? 'Subscribe to a channel to see messages.' : 'Waiting for messages…'}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center rounded px-2 py-0.5 text-xs',
        active ? 'bg-[var(--bg-active)] text-[var(--fg)]' : 'text-[var(--fg-muted)] hover:bg-[var(--bg-hover)]',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

interface LiveLog {
  lines: string[];
  dropped: number;
  paused: boolean;
  setPaused: (paused: boolean) => void;
  push: (incoming: string[]) => void;
  clear: () => void;
}

function useLiveLog(): LiveLog {
  const [lines, setLines] = React.useState<string[]>([]);
  const [dropped, setDropped] = React.useState(0);
  const [paused, setPausedState] = React.useState(false);
  const buffer = React.useRef<string[]>([]);
  const droppedRef = React.useRef(0);
  const pausedRef = React.useRef(false);

  const push = React.useCallback((incoming: string[]) => {
    if (pausedRef.current) {
      droppedRef.current += incoming.length;
      return;
    }
    // Appended one at a time rather than spread: a single burst can carry more
    // lines than the argument limit of a call.
    for (const line of incoming) buffer.current.push(line);
    // Trim on arrival too: a burst between two flushes must not be unbounded.
    if (buffer.current.length > RING_CAPACITY) {
      buffer.current = buffer.current.slice(buffer.current.length - RING_CAPACITY);
    }
  }, []);

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (buffer.current.length > 0) {
        const incoming = buffer.current;
        buffer.current = [];
        setLines((prev) => {
          const next = prev.concat(incoming);
          return next.length > RING_CAPACITY ? next.slice(next.length - RING_CAPACITY) : next;
        });
      }
      if (droppedRef.current > 0) {
        setDropped((prev) => prev + droppedRef.current);
        droppedRef.current = 0;
      }
    }, FLUSH_MS);
    return () => clearInterval(timer);
  }, []);

  const setPaused = React.useCallback((next: boolean) => {
    pausedRef.current = next;
    setPausedState(next);
  }, []);

  const clear = React.useCallback(() => {
    buffer.current = [];
    droppedRef.current = 0;
    setLines([]);
    setDropped(0);
  }, []);

  return { lines, dropped, paused, setPaused, push, clear };
}

// ---------------------------------------------------------------------------
// Log view
// ---------------------------------------------------------------------------

function LogView({ log, empty }: { log: LiveLog; empty: string }) {
  const [filter, setFilter] = React.useState('');
  const [follow, setFollow] = React.useState(true);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  const { rows, invalid } = React.useMemo(() => matchLines(log.lines, filter), [log.lines, filter]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Follow the tail unless the user has scrolled away from it.
  React.useEffect(() => {
    if (!follow || rows.length === 0) return;
    virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
  }, [rows.length, follow, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    setFollow(atBottom);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <div className="relative min-w-0 flex-1">
          <Funnel className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-[var(--fg-subtle)]" />
          <Input
            className={cn('mono h-6 pl-6', invalid && 'border-[var(--danger)]')}
            placeholder="filter — plain text, or /regex/"
            value={filter}
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <Checkbox label="Follow" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="text-[11px]" />
        <Button
          size="xs"
          variant={log.paused ? 'primary' : 'ghost'}
          icon={log.paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          onClick={() => log.setPaused(!log.paused)}
        >
          {log.paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="xs" variant="ghost" icon={<Eraser className="size-3" />} onClick={log.clear}>
          Clear
        </Button>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && (
          <p className="mono px-2 py-2 text-[var(--fg-subtle)]">
            {log.lines.length === 0 ? empty : `No line matches ${filter}.`}
          </p>
        )}
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => (
            <div
              key={item.key}
              className="mono absolute left-0 top-0 w-max whitespace-pre px-2 text-[var(--fg)]"
              style={{ height: ROW_HEIGHT, lineHeight: `${ROW_HEIGHT}px`, transform: `translateY(${item.start}px)` }}
            >
              {rows[item.index]}
            </div>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)]">
        <Radio className="size-3" />
        <span className="tabular-nums">
          {rows.length.toLocaleString()}
          {filter ? ` of ${log.lines.length.toLocaleString()}` : ''} lines
        </span>
        <span className="text-[var(--fg-subtle)]">ring buffer {RING_CAPACITY.toLocaleString()}</span>
        {log.dropped > 0 && (
          <span className="text-[var(--warn)] tabular-nums">{log.dropped.toLocaleString()} dropped while paused</span>
        )}
        {!follow && <span className="ml-auto text-[var(--fg-subtle)]">scrolled back — following is off</span>}
      </div>
    </div>
  );
}

/** `/…/` is a regex, anything else is a case-insensitive substring. */
function matchLines(lines: string[], filter: string): { rows: string[]; invalid: boolean } {
  const text = filter.trim();
  if (text === '') return { rows: lines, invalid: false };
  if (text.length > 2 && text.startsWith('/') && text.endsWith('/')) {
    try {
      const re = new RegExp(text.slice(1, -1), 'i');
      return { rows: lines.filter((line) => re.test(line)), invalid: false };
    } catch {
      return { rows: lines, invalid: true };
    }
  }
  const needle = text.toLowerCase();
  return { rows: lines.filter((line) => line.toLowerCase().includes(needle)), invalid: false };
}

function stamp(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}
