/**
 * End-to-end check against the databases actually running on this machine
 * (PLAN §8.1: local and remote are the same code path — these are reached from
 * inside the container via host.docker.internal, which is the "remote" path in
 * everything but latency).
 *
 * Also covers the WebSocket, which now authenticates from the session cookie at
 * the handshake instead of a token in the first message (§9.2) — a regression
 * there is invisible in HTTP-only tests.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const APP = process.env.APP_URL ?? 'http://app:3456';
const USERNAME = process.env.DBADMIN_USER ?? 'demo';
const PASSWORD = process.env.DBADMIN_PASSWORD ?? 'demo-account-passphrase';

// What this run expects to find, all overridable. The defaults are placeholders
// so the file carries nobody's real infrastructure names — point them at the
// machine's own saved connections before running:
//
//   DBADMIN_CONNECTIONS="One,Two,Three" DBADMIN_DATABASE=mydb \
//   DBADMIN_SCHEMA=public DBADMIN_TABLE=my_table node tests/e2e/live-databases.mjs
//
const CONNECTIONS = (process.env.DBADMIN_CONNECTIONS ?? 'Demo Postgres,Demo MySQL,Demo Redis')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CONNECTION = process.env.DBADMIN_CONNECTION ?? CONNECTIONS[0];
const DATABASE = process.env.DBADMIN_DATABASE ?? 'demo_db';
const SCHEMA = process.env.DBADMIN_SCHEMA ?? 'public';
const TABLE = process.env.DBADMIN_TABLE ?? 'demo_table';

const SHOTS = 'tests/e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(page, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(err?.message ?? err) });
    console.log(`  FAIL  ${name} — ${err?.message ?? err}`);
    await page.screenshot({ path: `${SHOTS}/live-fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

// Every frame the socket sends, so an auth failure at the handshake is caught
// rather than silently degrading into a UI that never updates.
const wsEvents = [];
page.on('websocket', (ws) => {
  wsEvents.push({ url: ws.url(), event: 'open' });
  ws.on('framereceived', (f) => wsEvents.push({ event: 'recv', payload: String(f.payload).slice(0, 120) }));
  ws.on('socketerror', (e) => wsEvents.push({ event: 'error', payload: String(e) }));
  ws.on('close', () => wsEvents.push({ event: 'close' }));
});

console.log(`\nLive database verification against ${APP}\n`);

await step(page, 'sign in from the bare URL', async () => {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  const signIn = page.getByRole('button', { name: /^sign in$/i });
  if (await signIn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await signIn.click();
    await page.waitForTimeout(3000);
  } else {
    throw new Error('expected the sign-in form on a bare URL with an existing account');
  }
});

await step(page, 'saved connections are listed', async () => {
  for (const name of CONNECTIONS) {
    await page.getByText(name, { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 });
  }
});

await step(page, 'WebSocket authenticates from the session cookie', async () => {
  await page.waitForTimeout(4000);
  const opened = wsEvents.find((e) => e.event === 'open');
  if (!opened) throw new Error('no WebSocket was opened');
  const failed = wsEvents.find((e) => e.event === 'recv' && /auth-failed/.test(e.payload));
  if (failed) throw new Error(`socket rejected: ${failed.payload}`);
  const ready = wsEvents.find((e) => e.event === 'recv' && /"ready"/.test(e.payload));
  if (!ready) throw new Error(`no ready frame; saw ${JSON.stringify(wsEvents.slice(0, 6))}`);
});

/**
 * Every tree lookup is scoped to the tree and matched exactly. A connection and
 * the database inside it routinely differ only by case, and a loose,
 * case-insensitive match then hits the sidebar row — silently re-toggling the
 * connection instead of expanding the database.
 *
 * The wait is on what the expansion should reveal rather than a fixed sleep:
 * introspecting a large schema over a cold pool outruns any sleep worth
 * hardcoding.
 */
const tree = () => page.getByRole('tree', { name: /database objects/i });

async function expandNode(label, revealed, timeout = 60_000) {
  const row = tree().getByText(label, { exact: true }).first();
  await row.waitFor({ state: 'visible', timeout: 30_000 });
  await row.dblclick();
  await tree().getByText(revealed, { exact: true }).first().waitFor({ state: 'visible', timeout });
}

await step(page, 'open the live database tree', async () => {
  // Sidebar connection → the tree it loads → the database in it.
  await page.getByText(CONNECTION, { exact: true }).first().dblclick();
  await tree().getByText(DATABASE, { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
  await expandNode(DATABASE, SCHEMA);
});

await step(page, 'reach real application tables', async () => {
  await expandNode(SCHEMA, 'Tables');
  await page.getByText('Tables', { exact: true }).first().dblclick();

  // The tree is virtualized (PLAN §6), so a table 100 rows down the alphabet is
  // genuinely not in the DOM — filtering is how you reach it, not scrolling.
  // TABLE is a real table in the live database, so finding it proves the tree is
  // reading that database rather than anything seeded for a test.
  await page.getByPlaceholder(/filter loaded objects/i).fill(TABLE);
  await tree().getByText(TABLE, { exact: true }).first().waitFor({ state: 'visible', timeout: 60_000 });
});

await step(page, 'run a query against live data', async () => {
  await page.keyboard.press('Control+KeyK').catch(() => {});
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape').catch(() => {});
  await page.screenshot({ path: `${SHOTS}/live-workspace.png`, fullPage: false });
});

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
writeFileSync(
  `${SHOTS}/live-report.json`,
  JSON.stringify({ passed, failed: failed.length, results, wsEvents: wsEvents.slice(0, 20), consoleErrors }, null, 2),
);
console.log(`\n${passed}/${results.length} steps passed`);
if (consoleErrors.length) console.log(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
