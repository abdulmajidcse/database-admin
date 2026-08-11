/**
 * SSH tunnels and remote execution (PLAN §8.2 "SSH tunnel" row, §8.3 keepalive
 * and reconnect, §8.4 remote-side dumps).
 *
 * A tunnel is a chain of hops (ProxyJump / bastion) ending in a local
 * `net.Server` on 127.0.0.1:<ephemeral>; every accepted socket is forwarded
 * through the last hop with `forwardOut()`. Connectors never see any of this —
 * they receive the local endpoint from the AccessResolver (§8.1).
 *
 * Server-side only. No React, no Next (PLAN §11).
 */

import net from 'node:net';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Readable } from 'node:stream';
import { Client } from 'ssh2';
import type { ClientChannel, ConnectConfig } from 'ssh2';
import type { SshHop } from '../../lib/connection';
import { CONFIG, IS_CONTAINER } from '../config';
import { allocatePort, releasePort } from './ports';

// ---------------------------------------------------------------------------
// Tunables (PLAN §8.3 — "Idle connections die", "Reconnect properly")
// ---------------------------------------------------------------------------

/** SSH-level keepalive. Well under the typical 5-minute NAT idle window. */
const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_COUNT_MAX = 4;
/** TCP keepalive on the local leg, so a dead app-side socket is noticed too. */
const SOCKET_KEEPALIVE_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 20_000;
/**
 * Consecutive failures before the tunnel declares itself dead. With the backoff
 * below that is ~3 minutes of retrying — enough to ride out a network blip or a
 * short sleep (M0: "survive the laptop sleeping") without becoming a zombie
 * that retries forever. Longer outages are covered by the resolver: `healthy()`
 * turns false and the next resolve() builds a fresh tunnel.
 */
const RECONNECT_MAX_ATTEMPTS = 10;
/** How long an inbound local socket waits for an in-flight reconnect. */
const CONNECT_WAIT_MS = 15_000;
/** Docker Desktop's forwarded agent socket (PLAN §10.3). */
const DOCKER_DESKTOP_AGENT_SOCK = '/run/host-services/ssh-auth.sock';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// OpenSSH config parsing (PLAN §8.2 — "Parse ~/.ssh/config so a saved host name
// just works")
// ---------------------------------------------------------------------------

export interface SshConfigEntry {
  hostName?: string;
  port?: number;
  user?: string;
  /** In file order; OpenSSH tries them in turn, we take the first readable one. */
  identityFiles: string[];
  /** Raw `ProxyJump` value: a comma-separated list of `[user@]host[:port]`. */
  proxyJump?: string;
}

interface ConfigBlock {
  /** Host patterns this block applies to. Empty means "never" (a Match block). */
  patterns: string[];
  settings: [string, string][];
}

interface ConfigCache {
  blocks: ConfigBlock[];
  readAt: number;
  signature: string;
}

const CONFIG_CACHE_TTL_MS = 5_000;
const configCache = new Map<string, ConfigCache>();

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** OpenSSH host patterns: `*`, `?`, and a leading `!` for negation. */
function patternToRegExp(pattern: string): RegExp {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

function patternsMatch(patterns: string[], host: string): boolean {
  let matched = false;
  for (const raw of patterns) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (!patternToRegExp(pattern).test(host)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** Split an ssh_config line into keyword + argument (`=` and whitespace both work). */
function splitDirective(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const m = /^([A-Za-z0-9_-]+)\s*(?:=|\s)\s*(.*)$/.exec(trimmed);
  if (!m) return null;
  return [m[1].toLowerCase(), m[2].trim()];
}

/** Whitespace-separated args, honouring double quotes. */
function splitArgs(value: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

function expandIncludeGlob(spec: string, baseDir: string): string[] {
  const abs = path.isAbsolute(spec) ? spec : path.join(baseDir, expandTilde(spec));
  const resolved = expandTilde(abs);
  if (!resolved.includes('*') && !resolved.includes('?')) return existsSync(resolved) ? [resolved] : [];
  const dir = path.dirname(resolved);
  const re = patternToRegExp(path.basename(resolved));
  try {
    return readdirSync(dir)
      .filter((name) => re.test(name))
      .map((name) => path.join(dir, name))
      .filter((f) => statSync(f).isFile())
      .sort();
  } catch {
    return [];
  }
}

function readConfigInto(file: string, blocks: ConfigBlock[], depth: number, seen: Set<string>): void {
  if (depth > 8 || seen.has(file)) return; // Include loops are a real thing.
  seen.add(file);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  // Directives before the first `Host` apply to every host.
  let current: ConfigBlock = { patterns: ['*'], settings: [] };
  blocks.push(current);
  for (const line of text.split('\n')) {
    const directive = splitDirective(line);
    if (!directive) continue;
    const [keyword, value] = directive;
    if (keyword === 'host') {
      current = { patterns: splitArgs(value), settings: [] };
      blocks.push(current);
      continue;
    }
    if (keyword === 'match') {
      // Match conditions (exec/originalhost/…) need a full evaluator; rather
      // than guess wrong, the block is parsed but never applied.
      current = { patterns: [], settings: [] };
      blocks.push(current);
      continue;
    }
    if (keyword === 'include') {
      for (const spec of splitArgs(value)) {
        for (const included of expandIncludeGlob(spec, path.dirname(file))) {
          readConfigInto(included, blocks, depth + 1, seen);
        }
      }
      // Directives after an Include continue in the enclosing block.
      const resume: ConfigBlock = { patterns: current.patterns, settings: [] };
      blocks.push(resume);
      current = resume;
      continue;
    }
    current.settings.push([keyword, value]);
  }
}

function loadConfigBlocks(dir: string): ConfigBlock[] {
  const file = path.join(dir, 'config');
  let signature = '';
  try {
    const st = statSync(file);
    signature = `${st.mtimeMs}:${st.size}`;
  } catch {
    signature = 'missing';
  }
  const cached = configCache.get(dir);
  const now = Date.now();
  if (cached && cached.signature === signature && now - cached.readAt < CONFIG_CACHE_TTL_MS) {
    return cached.blocks;
  }
  const blocks: ConfigBlock[] = [];
  readConfigInto(file, blocks, 0, new Set());
  configCache.set(dir, { blocks, readAt: now, signature });
  return blocks;
}

/**
 * Resolve an alias out of `CONFIG.sshDir/config`. OpenSSH semantics: the FIRST
 * value obtained for a keyword wins, so earlier blocks beat later ones.
 */
export function lookupSshConfig(alias: string, dir: string = CONFIG.sshDir): SshConfigEntry {
  const entry: SshConfigEntry = { identityFiles: [] };
  if (!alias) return entry;
  for (const block of loadConfigBlocks(dir)) {
    if (!patternsMatch(block.patterns, alias)) continue;
    for (const [keyword, value] of block.settings) {
      switch (keyword) {
        case 'hostname':
          entry.hostName ??= value;
          break;
        case 'port': {
          const port = Number.parseInt(value, 10);
          if (Number.isFinite(port) && entry.port === undefined) entry.port = port;
          break;
        }
        case 'user':
          entry.user ??= value;
          break;
        case 'identityfile':
          // Multiple IdentityFile lines accumulate rather than first-wins.
          for (const f of splitArgs(value)) entry.identityFiles.push(expandTilde(f));
          break;
        case 'proxyjump':
          entry.proxyJump ??= value;
          break;
        default:
          break;
      }
    }
  }
  // `%h` is the only token we can expand without knowing the command line.
  if (entry.hostName) entry.hostName = entry.hostName.replace(/%h/g, alias);
  return entry;
}

// ---------------------------------------------------------------------------
// known_hosts verification (PLAN §9 — a tunnel we cannot authenticate is a MITM
// waiting to happen; an unknown host is trusted, a CHANGED host never is)
// ---------------------------------------------------------------------------

interface KnownHostEntry {
  marker: 'revoked' | 'cert-authority' | null;
  hosts: string[];
  /** `ssh-ed25519`, `ssh-rsa`, … */
  keyType: string;
  /** base64 of the wire-format public key blob, exactly what ssh2 hands us. */
  key: string;
}

let knownHostsCache: { entries: KnownHostEntry[]; signature: string; readAt: number } | null = null;

function loadKnownHosts(): KnownHostEntry[] {
  const file = path.join(CONFIG.sshDir, 'known_hosts');
  let signature = 'missing';
  try {
    const st = statSync(file);
    signature = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no known_hosts — first-use trust below */
  }
  const now = Date.now();
  if (knownHostsCache && knownHostsCache.signature === signature && now - knownHostsCache.readAt < CONFIG_CACHE_TTL_MS) {
    return knownHostsCache.entries;
  }
  const entries: KnownHostEntry[] = [];
  try {
    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      let rest = line;
      let marker: KnownHostEntry['marker'] = null;
      if (rest.startsWith('@')) {
        const [m, ...tail] = rest.split(/\s+/);
        marker = m === '@revoked' ? 'revoked' : m === '@cert-authority' ? 'cert-authority' : null;
        rest = tail.join(' ');
      }
      const parts = rest.split(/\s+/);
      if (parts.length < 3) continue;
      entries.push({ marker, hosts: parts[0].split(','), keyType: parts[1], key: parts[2] });
    }
  } catch {
    /* unreadable file behaves like an empty one */
  }
  knownHostsCache = { entries, signature, readAt: now };
  return entries;
}

/** `[host]:port` for non-22, bare host otherwise — the OpenSSH spelling. */
function knownHostNames(host: string, port: number): string[] {
  return port === 22 ? [host] : [`[${host}]:${port}`, host];
}

function knownHostMatches(pattern: string, candidates: string[]): boolean {
  if (pattern.startsWith('|1|')) {
    // Hashed entry: |1|<base64 salt>|<base64 HMAC-SHA1(salt, host)>.
    const [, , salt, hash] = pattern.split('|');
    if (!salt || !hash) return false;
    return candidates.some(
      (c) => createHmac('sha1', Buffer.from(salt, 'base64')).update(c).digest('base64') === hash,
    );
  }
  return candidates.some((c) => patternToRegExp(pattern).test(c));
}

/** The algorithm name is the first length-prefixed string of the key blob. */
function keyBlobType(key: Buffer): string {
  if (key.length < 4) return '';
  const len = key.readUInt32BE(0);
  if (len <= 0 || key.length < 4 + len) return '';
  return key.subarray(4, 4 + len).toString('utf8');
}

/**
 * Reject a host whose key CHANGED (or was revoked); accept a host we have never
 * seen. Refusing unknown hosts outright would be unusable from a server process
 * that cannot prompt, but silently accepting a changed key is exactly the
 * failure mode host keys exist to prevent.
 *
 * Only entries of the SAME key type count: a server offering ed25519 while
 * known_hosts holds an old ssh-rsa line is not evidence of tampering, and
 * rejecting it would break connections plain `ssh` accepts.
 */
function makeHostVerifier(host: string, port: number): (key: Buffer) => boolean {
  const candidates = knownHostNames(host, port);
  return (key: Buffer): boolean => {
    const presented = key.toString('base64');
    const presentedType = keyBlobType(key);
    const entries = loadKnownHosts();
    let sawHost = false;
    for (const entry of entries) {
      if (!entry.hosts.some((h) => knownHostMatches(h, candidates))) continue;
      if (entry.marker === 'revoked' && entry.key === presented) return false;
      if (entry.marker !== null) continue; // CA entries cannot be checked here.
      if (entry.keyType !== presentedType) continue;
      sawHost = true;
      if (entry.key === presented) return true;
    }
    return !sawHost;
  };
}

// ---------------------------------------------------------------------------
// Hop resolution: config alias + ProxyJump + auth material
// ---------------------------------------------------------------------------

export interface ResolvedHop {
  host: string;
  port: number;
  username: string;
  auth: 'agent' | 'password' | 'key';
  privateKey?: Buffer;
  passphrase?: string;
  password?: string;
  agentSocket?: string;
  /** `user@host:port`, for logs, errors and tunnel identity. Never a secret. */
  label: string;
}

/**
 * The agent socket to use. Docker Desktop forwards the host agent at a fixed
 * path and does NOT set SSH_AUTH_SOCK for us (PLAN §10.3).
 */
export function resolveAgentSocket(): string {
  const fromEnv = process.env.SSH_AUTH_SOCK;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (existsSync(DOCKER_DESKTOP_AGENT_SOCK)) return DOCKER_DESKTOP_AGENT_SOCK;
  throw new Error(
    IS_CONTAINER
      ? 'No ssh-agent is reachable from the container. Mount Docker Desktop\'s agent socket ' +
        `(-v ${DOCKER_DESKTOP_AGENT_SOCK}:${DOCKER_DESKTOP_AGENT_SOCK}) and set SSH_AUTH_SOCK to it, ` +
        'or switch this hop to key authentication.'
      : 'No ssh-agent is running (SSH_AUTH_SOCK is unset). Start one, or switch this hop to key authentication.',
  );
}

const DEFAULT_IDENTITIES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function firstReadable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(CONFIG.sshDir, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function readPrivateKey(hint: string | undefined, cfg: SshConfigEntry, label: string): Buffer {
  const candidates: string[] = [];
  if (hint) candidates.push(expandTilde(hint));
  candidates.push(...cfg.identityFiles);
  candidates.push(...DEFAULT_IDENTITIES.map((n) => path.join(CONFIG.sshDir, n)));
  const file = firstReadable(candidates);
  if (!file) {
    throw new Error(
      `No private key found for ${label}. Looked at: ${candidates.join(', ') || '(nothing configured)'}. ` +
        `Under Docker, ~/.ssh must be mounted into the container (see ${CONFIG.sshDir}).`,
    );
  }
  try {
    return readFileSync(file);
  } catch (err) {
    throw new Error(`Cannot read the private key ${file} for ${label}: ${(err as Error).message}`);
  }
}

/** `[user@]host[:port]` as it appears in ProxyJump. */
function parseJumpSpec(spec: string): { user?: string; host: string; port?: number } {
  let rest = spec.trim();
  let user: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let port: number | undefined;
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    const hostPart = rest.slice(1, close);
    const portPart = rest.slice(close + 1);
    if (portPart.startsWith(':')) port = Number.parseInt(portPart.slice(1), 10);
    return { user, host: hostPart, port };
  }
  const colon = rest.lastIndexOf(':');
  if (colon > 0 && !rest.slice(colon + 1).includes(':')) {
    const maybePort = Number.parseInt(rest.slice(colon + 1), 10);
    if (Number.isFinite(maybePort)) {
      port = maybePort;
      rest = rest.slice(0, colon);
    }
  }
  return { user, host: rest, port };
}

function labelFor(username: string, host: string, port: number): string {
  return `${username}@${host}:${port}`;
}

/**
 * Turn a ProxyJump alias into a hop. Jump hosts have no stored secret of their
 * own, so they authenticate with an identity file when the config names one and
 * with the agent otherwise — the two setups that need no prompt.
 */
function hopFromJumpSpec(spec: string, seen: Set<string>): ResolvedHop[] {
  const parsed = parseJumpSpec(spec);
  if (!parsed.host) return [];
  const key = parsed.host.toLowerCase();
  if (seen.has(key)) return []; // ProxyJump cycle
  seen.add(key);

  const cfg = lookupSshConfig(parsed.host);
  const chain: ResolvedHop[] = [];
  if (cfg.proxyJump && cfg.proxyJump.toLowerCase() !== 'none') {
    for (const nested of cfg.proxyJump.split(',')) chain.push(...hopFromJumpSpec(nested, seen));
  }

  const host = cfg.hostName ?? parsed.host;
  const port = parsed.port ?? cfg.port ?? 22;
  const username = parsed.user ?? cfg.user ?? process.env.USER ?? 'root';
  const label = labelFor(username, host, port);
  const identity = firstReadable(cfg.identityFiles);
  chain.push(
    identity
      ? { host, port, username, auth: 'key', privateKey: readFileSync(identity), label }
      : { host, port, username, auth: 'agent', agentSocket: resolveAgentSocket(), label },
  );
  return chain;
}

/**
 * Expand configured hops into the exact dial order, applying ~/.ssh/config and
 * ProxyJump (PLAN §8.2). `secrets[i]` is the vault secret for `hops[i]`: the
 * password for password auth, the passphrase for an encrypted key.
 */
export function resolveHops(hops: SshHop[], secrets: (string | null)[] = []): ResolvedHop[] {
  const out: ResolvedHop[] = [];
  hops.forEach((hop, index) => {
    const cfg: SshConfigEntry = hop.sshConfigHost ? lookupSshConfig(hop.sshConfigHost) : { identityFiles: [] };
    const seen = new Set<string>();
    if (hop.sshConfigHost) seen.add(hop.sshConfigHost.toLowerCase());
    // A bastion named by ProxyJump must be dialled BEFORE the host that names it.
    if (cfg.proxyJump && cfg.proxyJump.toLowerCase() !== 'none') {
      for (const spec of cfg.proxyJump.split(',')) out.push(...hopFromJumpSpec(spec, seen));
    }

    const host = hop.host || cfg.hostName || hop.sshConfigHost || '';
    if (!host) throw new Error(`SSH hop ${index + 1} has no host and no resolvable ~/.ssh/config alias.`);
    const port = hop.port || cfg.port || 22;
    const username = hop.username || cfg.user || process.env.USER || 'root';
    const label = labelFor(username, host, port);
    const secret = secrets[index] ?? null;

    switch (hop.auth) {
      case 'password': {
        if (secret === null) throw new Error(`No stored password for SSH hop ${label}.`);
        out.push({ host, port, username, auth: 'password', password: secret, label });
        break;
      }
      case 'key': {
        const privateKey = readPrivateKey(hop.privateKeyPath, cfg, label);
        if (hop.keyHasPassphrase && secret === null) {
          throw new Error(`The key for SSH hop ${label} needs a passphrase, but none is stored.`);
        }
        out.push({
          host,
          port,
          username,
          auth: 'key',
          privateKey,
          passphrase: hop.keyHasPassphrase ? secret ?? undefined : undefined,
          label,
        });
        break;
      }
      case 'agent':
      default:
        out.push({ host, port, username, auth: 'agent', agentSocket: resolveAgentSocket(), label });
        break;
    }
  });
  if (out.length === 0) throw new Error('SSH access needs at least one hop.');
  return out;
}

/** Stable identity for refcounting — never includes secret material (§8.1). */
export function hopChainKey(hops: ResolvedHop[]): string {
  return hops.map((h) => `${h.label}/${h.auth}`).join('->');
}

// ---------------------------------------------------------------------------
// The hop chain
// ---------------------------------------------------------------------------

export type TunnelEvent =
  | { type: 'state'; state: 'connecting' | 'connected' | 'reconnecting' | 'closed'; message?: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; message: string };

function friendlyAuthError(err: Error, hop: ResolvedHop): Error {
  const msg = err.message || String(err);
  if (/All configured authentication methods failed/i.test(msg)) {
    const how =
      hop.auth === 'agent'
        ? `the ssh-agent at ${hop.agentSocket ?? '(unset)'} (is the key loaded? \`ssh-add -l\`)`
        : hop.auth === 'key'
          ? 'the configured private key (wrong key, or a passphrase is required)'
          : 'the stored password';
    return new Error(`SSH authentication failed for ${hop.label} using ${how}.`);
  }
  if (/Handshake failed|Timed out while waiting for handshake/i.test(msg)) {
    return new Error(`SSH handshake with ${hop.label} timed out or was rejected: ${msg}`);
  }
  if (/Host key verification|verification failed/i.test(msg) || /hostVerifier/i.test(msg)) {
    return new Error(
      `Host key verification failed for ${hop.label}. The key differs from the one in ` +
        `${path.join(CONFIG.sshDir, 'known_hosts')} — refusing to connect.`,
    );
  }
  return new Error(`SSH connection to ${hop.label} failed: ${msg}`);
}

function connectHop(hop: ResolvedHop, sock?: ClientChannel): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const cfg: ConnectConfig = {
      host: hop.host,
      port: hop.port,
      username: hop.username,
      // §8.3: idle SSH sessions are the first thing NAT drops.
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      readyTimeout: HANDSHAKE_TIMEOUT_MS,
      hostVerifier: makeHostVerifier(hop.host, hop.port),
    };
    // Every hop after the first rides inside a channel of the previous one.
    if (sock) cfg.sock = sock;

    switch (hop.auth) {
      case 'agent':
        cfg.agent = hop.agentSocket ?? resolveAgentSocket();
        break;
      case 'key':
        cfg.privateKey = hop.privateKey;
        if (hop.passphrase !== undefined) cfg.passphrase = hop.passphrase;
        break;
      case 'password':
        cfg.password = hop.password;
        // Plenty of servers only offer keyboard-interactive for passwords.
        cfg.tryKeyboard = true;
        client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => {
          finish([hop.password ?? '']);
        });
        break;
    }

    const cleanup = () => {
      client.removeListener('ready', onReady);
      client.removeListener('error', onError);
      client.removeListener('close', onClose);
    };
    const onReady = () => {
      cleanup();
      resolve(client);
    };
    const onError = (err: Error) => {
      cleanup();
      try {
        client.end();
      } catch {
        /* already gone */
      }
      reject(friendlyAuthError(err, hop));
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`SSH connection to ${hop.label} closed before it was ready.`));
    };
    client.once('ready', onReady);
    client.once('error', onError);
    client.once('close', onClose);

    try {
      client.connect(cfg);
    } catch (err) {
      cleanup();
      reject(friendlyAuthError(err as Error, hop));
    }
  });
}

function forwardChannel(client: Client, from: ResolvedHop, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) {
        reject(new Error(`${from.label} could not open a channel to ${host}:${port}: ${err.message}`));
        return;
      }
      resolve(stream);
    });
  });
}

/** One connected chain of hops. The last client is the one that reaches the DB. */
class SshChain {
  private clients: Client[] = [];
  private closing = false;
  private brokenCb: ((err: Error) => void) | null = null;
  connected = false;

  constructor(private readonly hops: ResolvedHop[]) {}

  get tail(): Client {
    const last = this.clients[this.clients.length - 1];
    if (!last) throw new Error('SSH chain is not connected.');
    return last;
  }

  onBroken(cb: (err: Error) => void): void {
    this.brokenCb = cb;
  }

  async connect(): Promise<void> {
    let sock: ClientChannel | undefined;
    try {
      for (let i = 0; i < this.hops.length; i++) {
        const hop = this.hops[i];
        const client = await connectHop(hop, sock);
        this.clients.push(client);
        this.watch(client, hop);
        const next = this.hops[i + 1];
        if (next) sock = await forwardChannel(client, hop, next.host, next.port);
      }
      this.connected = true;
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private watch(client: Client, hop: ResolvedHop): void {
    const fail = (err: Error) => {
      if (this.closing || !this.connected) return;
      this.connected = false;
      this.brokenCb?.(err);
    };
    client.on('error', (err: Error) => fail(new Error(`${hop.label}: ${err.message}`)));
    client.on('close', () => fail(new Error(`SSH connection to ${hop.label} dropped.`)));
  }

  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    const clients = this.clients;
    this.clients = [];
    // Innermost hop first, so intermediate channels close cleanly.
    for (const client of [...clients].reverse()) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The tunnel
// ---------------------------------------------------------------------------

export interface SshTunnelOptions {
  hops: ResolvedHop[];
  /** Where the LAST hop should connect on the user's behalf. */
  target: { host: string; port: number };
  /** Entrance address. Loopback only — never expose a tunnel to the LAN (§9.1). */
  localHost?: string;
  onEvent?: (e: TunnelEvent) => void;
}

/**
 * A local port forward through a hop chain (PLAN §8.1). The local listener
 * outlives any individual SSH failure, so the port handed to a connector stays
 * valid across a reconnect and the editor keeps its state (§8.3).
 */
export class SshTunnel {
  readonly localHost: string;
  readonly localPort: number;
  readonly target: { host: string; port: number };
  private readonly hops: ResolvedHop[];
  private readonly server: net.Server;
  private chain: SshChain;
  private listeners = new Set<(e: TunnelEvent) => void>();
  private reconnecting: Promise<void> | null = null;
  private closed = false;
  private dead = false;
  private sockets = new Set<net.Socket>();

  private constructor(
    opts: SshTunnelOptions,
    server: net.Server,
    localHost: string,
    localPort: number,
    chain: SshChain,
  ) {
    this.hops = opts.hops;
    this.target = opts.target;
    this.server = server;
    this.localHost = localHost;
    this.localPort = localPort;
    this.chain = chain;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
  }

  static async open(opts: SshTunnelOptions): Promise<SshTunnel> {
    const localHost = opts.localHost ?? '127.0.0.1';
    const chain = new SshChain(opts.hops);
    // Connect first: auth problems must surface as connection errors, not as a
    // mysteriously refused local port.
    await chain.connect();

    let tunnel: SshTunnel | null = null;
    let lastError: unknown;
    // A port can be stolen between allocation and listen; retry a couple of times.
    for (let attempt = 0; attempt < 3 && tunnel === null; attempt++) {
      const port = await allocatePort(localHost);
      const server = net.createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            server.removeListener('error', onError);
            resolve();
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen({ host: localHost, port, exclusive: true });
        });
        tunnel = new SshTunnel(opts, server, localHost, port, chain);
      } catch (err) {
        lastError = err;
        server.on('error', () => {
          /* a failed listener must not throw later */
        });
        server.close();
      } finally {
        releasePort(port);
      }
    }
    if (!tunnel) {
      await chain.close();
      throw new Error(`Could not open a local tunnel entrance: ${(lastError as Error)?.message ?? 'unknown error'}`);
    }
    tunnel.attach();
    return tunnel;
  }

  subscribe(fn: (e: TunnelEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: TunnelEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a listener must never take the tunnel down */
      }
    }
  }

  private attach(): void {
    this.chain.onBroken((err) => this.onBroken(err));
    this.server.on('connection', (socket) => this.onLocalConnection(socket));
    this.server.on('error', (err: Error) => this.emit({ type: 'error', message: err.message }));
    this.emit({ type: 'state', state: 'connected' });
  }

  get description(): string {
    return `${this.localHost}:${this.localPort} -> ${this.target.host}:${this.target.port} via ${this.hops
      .map((h) => h.label)
      .join(' -> ')}`;
  }

  /**
   * Liveness check used before a cached tunnel is handed out again (§8.1
   * "health checks"). Waits out an in-flight reconnect rather than condemning a
   * tunnel that is already healing itself.
   *
   * Deliberately NOT a TCP probe of the local port: connecting to our own
   * entrance would open — and immediately abort — a real database connection on
   * the far side, which shows up as a protocol error in the server's log. The
   * listener state plus the chain state tell us everything a probe would.
   */
  async healthy(): Promise<boolean> {
    if (this.closed || this.dead) return false;
    if (!this.server.listening) return false;
    if (!this.chain.connected) {
      try {
        await this.ensureConnected(5_000);
      } catch {
        return false;
      }
    }
    return this.chain.connected && !this.closed && !this.dead;
  }

  private onBroken(err: Error): void {
    if (this.closed) return;
    this.emit({ type: 'state', state: 'reconnecting', message: err.message });
    // §8.3: reconnect on our own rather than waiting for the next query to fail.
    void this.ensureConnected().catch((e: Error) => {
      this.emit({ type: 'error', message: e.message });
    });
  }

  /** Resolve once the chain is usable, reconnecting with backoff if needed. */
  private ensureConnected(timeoutMs = CONNECT_WAIT_MS): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Tunnel is closed.'));
    if (this.chain.connected) return Promise.resolve();
    if (!this.reconnecting) {
      this.reconnecting = this.reconnectLoop().finally(() => {
        this.reconnecting = null;
      });
    }
    const inFlight = this.reconnecting;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the SSH tunnel to reconnect.')), timeoutMs);
      inFlight.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private async reconnectLoop(): Promise<void> {
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
      if (this.closed) throw new Error('Tunnel is closed.');
      await this.chain.close();
      const chain = new SshChain(this.hops);
      chain.onBroken((err) => this.onBroken(err));
      this.chain = chain;
      try {
        await chain.connect();
        // close() may have landed while we were handshaking.
        if (this.closed) {
          await chain.close();
          throw new Error('Tunnel is closed.');
        }
        this.emit({ type: 'state', state: 'connected', message: 'SSH tunnel re-established.' });
        return;
      } catch (err) {
        const message = (err as Error).message;
        this.emit({ type: 'error', message: `SSH reconnect attempt ${attempt} failed: ${message}` });
        if (attempt === RECONNECT_MAX_ATTEMPTS) {
          // Give up; the resolver's health check rebuilds a fresh tunnel on the
          // next resolve() rather than leaving a zombie retrying forever.
          this.dead = true;
          throw new Error(`SSH tunnel could not be re-established: ${message}`);
        }
        // Exponential backoff with jitter (§8.3).
        const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (attempt - 1));
        await sleep(base / 2 + Math.random() * (base / 2));
      }
    }
  }

  private onLocalConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);
    // §8.3: the local leg gets keepalives too, so a half-open socket is noticed.
    socket.setKeepAlive(true, SOCKET_KEEPALIVE_MS);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.sockets.delete(socket));

    const dial = () => {
      let client: Client;
      try {
        client = this.chain.tail;
      } catch (err) {
        this.emit({ type: 'error', message: (err as Error).message });
        socket.destroy();
        return;
      }
      client.forwardOut(
        socket.remoteAddress ?? '127.0.0.1',
        socket.remotePort ?? 0,
        this.target.host,
        this.target.port,
        (err, stream) => {
          if (err) {
            // Usually "connection refused by the target", i.e. the DATABASE is
            // down — not the chain. Rebuilding the tunnel here would punish
            // every failed dial with a full handshake, so only the chain's own
            // error/close events trigger a reconnect.
            this.emit({
              type: 'error',
              message: `Tunnel could not reach ${this.target.host}:${this.target.port}: ${err.message}`,
            });
            socket.destroy();
            return;
          }
          stream.on('error', () => socket.destroy());
          socket.pipe(stream).pipe(socket);
          stream.on('close', () => socket.destroy());
        },
      );
    };

    if (this.chain.connected) {
      dial();
      return;
    }
    // Arrived mid-reconnect: hold the socket until the chain is back.
    this.ensureConnected().then(dial, (err: Error) => {
      this.emit({ type: 'error', message: err.message });
      socket.destroy();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.chain.close();
    this.emit({ type: 'state', state: 'closed' });
    this.listeners.clear();
  }
}

/** Open a tunnel straight from stored config (resolves hops for the caller). */
export async function openSshTunnel(
  hops: SshHop[],
  target: { host: string; port: number },
  opts: { secrets?: (string | null)[]; onEvent?: (e: TunnelEvent) => void } = {},
): Promise<SshTunnel> {
  return SshTunnel.open({ hops: resolveHops(hops, opts.secrets), target, onEvent: opts.onEvent });
}

// ---------------------------------------------------------------------------
// Remote execution (PLAN §8.4 — run the dump ON the remote host and stream
// compressed bytes back)
// ---------------------------------------------------------------------------

export interface RemoteExit {
  code: number | null;
  signal?: string;
  /** Tail of stderr, for error reporting. */
  stderr: string;
}

export interface RemoteExec {
  /** The command's stdout. Consume it as a stream — dumps are unbounded. */
  stdout: Readable;
  /** Also drained internally so a chatty command cannot stall the channel. */
  stderr: Readable;
  exit: Promise<RemoteExit>;
  /** Last few KB of stderr seen so far. */
  stderrTail(): string;
  /** Kill the command and tear the chain down. */
  close(): Promise<void>;
}

const STDERR_TAIL_BYTES = 8 * 1024;

export interface RemoteExecOptions {
  /** Vault secrets per hop, same indexing as `resolveHops`. */
  secrets?: (string | null)[];
  env?: Record<string, string>;
}

/**
 * Run `command` on the final hop and hand back its stdout stream. The chain is
 * dedicated to this command: a multi-hour `mysqldump | gzip` must not share
 * fate with the interactive tunnel (§8.4).
 */
export async function execRemote(
  hops: SshHop[],
  command: string,
  opts: RemoteExecOptions = {},
): Promise<RemoteExec> {
  const chain = new SshChain(resolveHops(hops, opts.secrets));
  await chain.connect();

  let channel: ClientChannel;
  try {
    channel = await new Promise<ClientChannel>((resolve, reject) => {
      chain.tail.exec(command, { env: opts.env as NodeJS.ProcessEnv | undefined }, (err, ch) => {
        if (err) reject(new Error(`Remote command failed to start: ${err.message}`));
        else resolve(ch);
      });
    });
  } catch (err) {
    await chain.close();
    throw err;
  }

  let stderrTail = '';
  channel.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  let exitCode: number | null = null;
  let exitSignal: string | undefined;
  channel.on('exit', (code: number | null, signal?: string) => {
    exitCode = code;
    exitSignal = signal;
  });

  const exit = new Promise<RemoteExit>((resolve) => {
    channel.on('close', () => {
      void chain.close().then(() => resolve({ code: exitCode, signal: exitSignal, stderr: stderrTail }));
    });
  });

  return {
    stdout: channel,
    stderr: channel.stderr,
    exit,
    stderrTail: () => stderrTail,
    close: async () => {
      try {
        channel.destroy();
      } catch {
        /* ignore */
      }
      await chain.close();
    },
  };
}

/** Single-quote for a POSIX remote shell. Callers building commands MUST use it. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Probe for a binary on the remote host before choosing the remote-dump path
 * (§8.4 "Requires the tool to exist remotely, so probe first").
 */
export async function remoteWhich(
  hops: SshHop[],
  binary: string,
  opts: RemoteExecOptions = {},
): Promise<string | null> {
  const exec = await execRemote(hops, `command -v ${shellQuote(binary)} 2>/dev/null`, opts);
  let out = '';
  exec.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  const result = await exec.exit;
  const found = out.trim().split('\n')[0]?.trim() ?? '';
  return result.code === 0 && found.length > 0 ? found : null;
}
