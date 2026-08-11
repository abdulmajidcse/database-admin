/**
 * Proxy processes (PLAN §8.2, "Process proxy" row): `kubectl port-forward`,
 * `cloud-sql-proxy`, `aws ssm start-session`. "Spawn, wait for a ready pattern,
 * own the lifecycle, restart on exit."
 *
 * The command is always an argv ARRAY spawned without a shell — a shell string
 * would turn a connection name into command injection (PLAN §9).
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { waitForPort } from './ports';

export type ProxyEvent =
  | { type: 'state'; state: 'starting' | 'ready' | 'restarting' | 'stopped' }
  | { type: 'output'; line: string }
  | { type: 'error'; message: string };

export interface ProxyProcessOptions {
  /** argv[0] is the executable; the rest are arguments. Never a shell string. */
  argv: string[];
  /** Regex (as a string) that marks the proxy as ready, matched per output line. */
  readyPattern?: string;
  /** Ready deadline; also the settle delay when there is no pattern. */
  readyTimeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional TCP endpoint to poll once the process says it is ready. */
  probe?: { host: string; port: number };
  onEvent?: (e: ProxyEvent) => void;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
/** With no readyPattern, wait this long for an immediate crash instead. */
const SETTLE_MS = 1_500;
const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 15_000;
const MAX_RESTARTS = 6;
const OUTPUT_KEEP_LINES = 60;
const KILL_GRACE_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A supervised child process that fronts a database. Refcounted and shared by
 * the AccessResolver (§8.1), so it outlives any single connection.
 */
export class ProxyProcess {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private readonly recent: string[] = [];
  private listeners = new Set<(e: ProxyEvent) => void>();
  private restarts = 0;
  private restarting: Promise<void> | null = null;
  private stopped = false;
  private ready = false;

  private constructor(private readonly opts: ProxyProcessOptions) {
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  static async start(opts: ProxyProcessOptions): Promise<ProxyProcess> {
    if (opts.argv.length === 0 || !opts.argv[0]) {
      throw new Error('Process access needs a command; argv is empty.');
    }
    const proxy = new ProxyProcess(opts);
    await proxy.spawnAndWait();
    return proxy;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get command(): string {
    return this.opts.argv.join(' ');
  }

  subscribe(fn: (e: ProxyEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Last lines of stdout/stderr — the only useful thing to show when it fails. */
  recentOutput(): string {
    return this.recent.join('\n');
  }

  /** Alive, ready, and not mid-restart (§8.1 health checks). */
  healthy(): boolean {
    return !this.stopped && this.ready && this.child !== null && this.child.exitCode === null;
  }

  private emit(e: ProxyEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a listener must never take the proxy down */
      }
    }
  }

  private record(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.recent.push(trimmed);
      if (this.recent.length > OUTPUT_KEEP_LINES) this.recent.shift();
      this.emit({ type: 'output', line: trimmed });
    }
  }

  private async spawnAndWait(): Promise<void> {
    const { argv, cwd, env, readyPattern, readyTimeoutMs, probe } = this.opts;
    this.ready = false;
    this.emit({ type: 'state', state: 'starting' });

    // spawn(file, args) — no shell, so nothing in argv is ever interpreted.
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this.child = child;

    const timeoutMs = readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const pattern = readyPattern ? new RegExp(readyPattern) : null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onSpawnError);
        child.off('exit', onEarlyExit);
        if (err) reject(err);
        else resolve();
      };

      const consider = (text: string) => {
        this.record(text);
        if (pattern && pattern.test(text)) finish();
      };
      const onStdout = (buf: Buffer) => consider(buf.toString('utf8'));
      const onStderr = (buf: Buffer) => consider(buf.toString('utf8'));
      const onSpawnError = (err: Error) => {
        finish(
          new Error(
            `Could not start "${argv[0]}": ${err.message}. ` +
              'The binary must exist inside the container (PLAN §10.1 bakes the CLI tools into the image).',
          ),
        );
      };
      const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
        finish(
          new Error(
            `Proxy "${this.command}" exited ${signal ? `on ${signal}` : `with code ${code}`} before it was ready.` +
              (this.recent.length ? `\n${this.recentOutput()}` : ''),
          ),
        );
      };

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.once('error', onSpawnError);
      child.once('exit', onEarlyExit);

      const timer = setTimeout(
        () => {
          if (pattern) {
            finish(
              new Error(
                `Proxy "${this.command}" did not print /${pattern.source}/ within ${timeoutMs} ms.` +
                  (this.recent.length ? `\n${this.recentOutput()}` : ''),
              ),
            );
          } else {
            // No pattern: "still running after the settle delay" is the signal.
            finish();
          }
        },
        pattern ? timeoutMs : Math.min(SETTLE_MS, timeoutMs),
      );
    });

    // "Ready" on stdout does not always mean "listening" — confirm the port.
    if (probe) {
      const open = await waitForPort(probe.host, probe.port, { timeoutMs });
      if (!open) {
        await this.killChild();
        throw new Error(
          `Proxy "${this.command}" started but nothing is listening on ${probe.host}:${probe.port}.` +
            (this.recent.length ? `\n${this.recentOutput()}` : ''),
        );
      }
    }

    this.ready = true;
    // Keep the pipes drained for the life of the process; a full stdout pipe
    // deadlocks the child.
    child.stdout.on('data', (buf: Buffer) => this.record(buf.toString('utf8')));
    child.stderr.on('data', (buf: Buffer) => this.record(buf.toString('utf8')));
    child.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));
    child.once('exit', (code, signal) => this.onExit(code, signal));
    this.emit({ type: 'state', state: 'ready' });
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.stopped) return;
    this.ready = false;
    const why = signal ? `signal ${signal}` : `code ${code}`;
    this.emit({ type: 'error', message: `Proxy "${this.command}" exited with ${why}; restarting.` });
    // §8.2: own the lifecycle — restart on unexpected exit.
    void this.restart();
  }

  private restart(): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restarting = (async () => {
      while (!this.stopped && this.restarts < MAX_RESTARTS) {
        this.restarts++;
        const base = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** (this.restarts - 1));
        await sleep(base / 2 + Math.random() * (base / 2));
        if (this.stopped) return;
        this.emit({ type: 'state', state: 'restarting' });
        try {
          await this.spawnAndWait();
          this.restarts = 0;
          return;
        } catch (err) {
          this.emit({ type: 'error', message: (err as Error).message });
        }
      }
      if (!this.stopped) {
        // Give up: healthy() now reports false and the resolver builds a fresh
        // proxy on the next resolve() instead of looping forever.
        this.emit({ type: 'error', message: `Proxy "${this.command}" failed to restart; giving up.` });
      }
    })().finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, KILL_GRACE_MS);
      // `lib.dom` is in the tsconfig, so setTimeout's return type is not portable.
      (timer as { unref?: () => void }).unref?.();
      child.once('exit', done);
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    await this.killChild();
    this.emit({ type: 'state', state: 'stopped' });
    this.listeners.clear();
  }
}
