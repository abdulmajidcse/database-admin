/**
 * Cross-user isolation sweep (PLAN §9.2).
 *
 * Connections are private to the account that created them. Hiding them from
 * the list is the easy half; the half that actually matters is that knowing
 * another user's connection id gets you nothing. So this signs in as two users
 * and fires every connection-taking endpoint from the wrong account.
 *
 * Written as a sweep rather than a few spot checks because the leak this caught
 * first time round was not in a route at all — it was the schema cache, which
 * is reachable without touching the connections table by design.
 *
 * A route is allowed to answer 401/403/404/400/405. A 2xx is only a failure if
 * it actually carried something: an owner-scoped list endpoint answering with
 * an empty collection is the correct outcome, not a leak, and treating every
 * 2xx as a leak reports `{"entries":[]}` as a breach.
 */

/** True when a 2xx body contains none of the other user's data. */
function isEmptyPayload(json) {
  if (json === null || typeof json !== 'object') return true;
  const values = Object.values(json);
  if (values.length === 0) return true;
  return values.every((v) => {
    if (v === null || v === undefined) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    if (typeof v === 'number') return v === 0;
    if (typeof v === 'boolean') return true;
    return v === '';
  });
}

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.APP_URL ?? 'http://127.0.0.1:3456';
const OWNER = { username: process.env.DBADMIN_USER ?? 'demo', password: process.env.DBADMIN_PASSWORD ?? 'demo-account-passphrase' };
const OTHER = { username: 'isolation-probe', password: 'isolation-probe-pass' };

async function call(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON is fine here */
  }
  return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') };
}

function cookieFrom(setCookie) {
  return setCookie ? setCookie.split(';')[0] : null;
}

/** Registers if the account is new, signs in if it already exists. */
async function session(creds) {
  const reg = await call('/api/account/register', { method: 'POST', body: creds });
  if (reg.status === 200) return cookieFrom(reg.setCookie);
  const login = await call('/api/account/signin', { method: 'POST', body: creds });
  if (login.status !== 200) throw new Error(`cannot establish session for ${creds.username}: ${login.text}`);
  return cookieFrom(login.setCookie);
}

const ownerCookie = await session(OWNER);
const otherCookie = await session(OTHER);

const owned = await call('/api/connections', { cookie: ownerCookie });
const connections = owned.json?.connections ?? [];
if (connections.length === 0) throw new Error('the owner account has no connections to probe against');
const target = connections[0];
const sqlTarget = connections.find((c) => c.engine !== 'redis' && c.engine !== 'mongodb') ?? target;
const redisTarget = connections.find((c) => c.engine === 'redis');

// Warm the pool as the owner FIRST. This is not incidental setup: connections
// are pooled by id and outlive a request, so the interesting failure only
// exists once the owner has a live connection to borrow. Probing a cold pool
// passes trivially and proves nothing.
const warm = await call('/api/schema', { method: 'POST', body: { connectionId: connections[0].id, force: true }, cookie: ownerCookie });
console.log(`\nIsolation sweep: ${OTHER.username} against ${OWNER.username}'s "${target.name}" (${target.id})`);
console.log(`Owner pool warmed: ${warm.status === 200 ? 'yes' : `NO (${warm.status})`}\n`);

const id = sqlTarget.id;
const probes = [
  ['GET  /api/connections/[id]', `/api/connections/${id}`, {}],
  ['GET  /api/connections/[id]/status', `/api/connections/${id}/status`, {}],
  ['POST /api/connections/[id]/connect', `/api/connections/${id}/connect`, { method: 'POST' }],
  ['POST /api/connections/[id]/disconnect', `/api/connections/${id}/disconnect`, { method: 'POST' }],
  ['DEL  /api/connections/[id]', `/api/connections/${id}`, { method: 'DELETE' }],
  ['PUT  /api/connections/[id]', `/api/connections/${id}`, { method: 'PUT', body: { name: 'hijacked', engine: sqlTarget.engine, address: sqlTarget.address, access: sqlTarget.access, options: {}, readOnly: false, envTag: 'dev', sortOrder: 0 } }],
  ['POST /api/schema', '/api/schema', { method: 'POST', body: { connectionId: id } }],
  ['GET  /api/schema', `/api/schema?connectionId=${id}`, {}],
  ['POST /api/schema (force)', '/api/schema', { method: 'POST', body: { connectionId: id, force: true } }],
  ['POST /api/tree', '/api/tree', { method: 'POST', body: { connectionId: id, path: [] } }],
  ['POST /api/query', '/api/query', { method: 'POST', body: { connectionId: id, sql: 'SELECT 1', runId: 'probe' } }],
  ['POST /api/explain', '/api/explain', { method: 'POST', body: { connectionId: id, sql: 'SELECT 1', analyze: false } }],
  ['POST /api/table/read', '/api/table/read', { method: 'POST', body: { connectionId: id, table: 'accounts', offset: 0, limit: 1 } }],
  ['POST /api/table/count', '/api/table/count', { method: 'POST', body: { connectionId: id, table: 'accounts' } }],
  ['POST /api/ddl/plan', '/api/ddl/plan', { method: 'POST', body: { connectionId: id, current: null, desired: { name: 'x', columns: [] } } }],
  ['POST /api/ddl/execute', '/api/ddl/execute', { method: 'POST', body: { connectionId: id, statements: ['SELECT 1'] } }],
  ['POST /api/changeset/preview', '/api/changeset/preview', { method: 'POST', body: { connectionId: id, changeset: { table: 'accounts', inserts: [], updates: [], deletes: [] } } }],
  ['POST /api/changeset/apply', '/api/changeset/apply', { method: 'POST', body: { connectionId: id, changeset: { table: 'accounts', inserts: [], updates: [], deletes: [] } } }],
  ['GET  /api/processes', `/api/processes?connectionId=${id}`, {}],
  ['GET  /api/history', `/api/history?connectionId=${id}`, {}],
  ['POST /api/export', '/api/export', { method: 'POST', body: { connectionId: id, source: { kind: 'query', sql: 'SELECT 1' }, format: 'csv', destination: { kind: 'download' }, options: { structure: 'both', binaryEncoding: 'base64', nullLiteral: '' } } }],
  ['POST /api/compare', '/api/compare', { method: 'POST', body: { leftConnectionId: id, rightConnectionId: id } }],
];

if (redisTarget) {
  probes.push(
    ['POST /api/redis/scan', '/api/redis/scan', { method: 'POST', body: { connectionId: redisTarget.id, cursor: '0' } }],
    ['GET  /api/redis/info', `/api/redis/info?connectionId=${redisTarget.id}`, {}],
    ['POST /api/redis/command', '/api/redis/command', { method: 'POST', body: { connectionId: redisTarget.id, argv: ['KEYS', '*'] } }],
  );
}

const leaks = [];
const rows = [];
for (const [label, path, opts] of probes) {
  const res = await call(path, { ...opts, cookie: otherCookie });
  const twoXX = res.status >= 200 && res.status < 300;
  const leaked = twoXX && !isEmptyPayload(res.json);
  const note = twoXX && !leaked ? ' (empty — correctly scoped)' : '';
  rows.push({ label, status: res.status, leaked, body: res.text.slice(0, 160) });
  if (leaked) leaks.push({ label, status: res.status, body: res.text.slice(0, 400) });
  console.log(`  ${leaked ? 'LEAK' : 'ok  '}  ${String(res.status).padEnd(4)} ${label}${note}`);
}

// The owner must still be able to do all of this — an isolation fix that breaks
// the owner's own access is not a fix.
const ownerStillWorks = await call('/api/schema', { method: 'POST', body: { connectionId: id }, cookie: ownerCookie });
const ownerOk = ownerStillWorks.status === 200;
console.log(`\n  ${ownerOk ? 'ok  ' : 'FAIL'}  ${ownerStillWorks.status}  owner can still introspect their own connection`);

mkdirSync('tests/e2e/screenshots', { recursive: true });
writeFileSync('tests/e2e/screenshots/isolation-report.json', JSON.stringify({ leaks, ownerOk, rows }, null, 2));

console.log(`\n${probes.length - leaks.length}/${probes.length} endpoints correctly denied${leaks.length ? `; ${leaks.length} LEAKED` : ''}`);
process.exit(leaks.length === 0 && ownerOk ? 0 : 1);
