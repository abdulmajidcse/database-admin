/**
 * End-to-end browser verification (PLAN §13 "Manual smoke", automated).
 *
 * Drives the REAL app in a real browser against the REAL engines from the
 * compose `dbs` profile. Every step screenshots, so a failure is diagnosable
 * from the artefacts alone.
 *
 * Run from a Playwright container attached to the compose network:
 *   docker run --rm --network database-admin_dbadmin -v "$PWD":/w -w /w \
 *     mcr.microsoft.com/playwright:v1.56.0-noble node tests/e2e/browser-verify.mjs
 *
 * APP_URL defaults to compose.yml's `app` service on the compose network. Set
 * APP_URL=http://devapp:3456 to drive compose.dev.yml's HMR stack instead —
 * the two use different service names so their containers never collide.
 * Because the test runs inside a container, "localhost" would mean the test
 * container itself — the same §10.3 trap the app warns users about.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const APP = process.env.APP_URL ?? 'http://app:3456';
const USERNAME = process.env.DBADMIN_USER ?? 'smoke';
const PASSWORD = process.env.DBADMIN_PASSWORD ?? 'smoke-passphrase';
const SHOTS = 'tests/e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
let shotN = 0;

async function step(page, name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(err?.message ?? err) });
    console.log(`  FAIL  ${name}: ${err?.message ?? err}`);
  }
  await page
    .screenshot({ path: `${SHOTS}/${String(++shotN).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`, fullPage: false })
    .catch(() => {});
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// Surface client-side errors — a React crash otherwise looks like an empty page.
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

console.log(`\nBrowser verification against ${APP}\n`);

await step(page, 'app loads from the bare URL', async () => {
  // No `?t=` and nothing in localStorage: the account gate is the only way in
  // now, and reaching it must not require a secret (PLAN §9.2).
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  const title = await page.title();
  if (!title) throw new Error('no document title');
});

await step(page, 'create the account (first run)', async () => {
  const heading = page.getByText(/create your account/i).first();
  if (await heading.isVisible({ timeout: 8000 }).catch(() => false)) {
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/^password$/i).fill(PASSWORD);
    await page.getByLabel(/confirm password/i).fill(PASSWORD);
    const create = page.getByRole('button', { name: /create account/i });
    if (await create.isDisabled()) throw new Error('Create account still disabled after filling every field');
    await create.click();
  } else {
    // The account already exists (a re-run against the same volume): sign in.
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).first().fill(PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();
  }
  await page.waitForTimeout(3000);
});

await step(page, 'session cookie is HttpOnly and SameSite=Strict', async () => {
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'dbadmin_session');
  if (!session) throw new Error('no session cookie was set');
  if (!session.httpOnly) throw new Error('session cookie is readable from JavaScript');
  if (String(session.sameSite).toLowerCase() !== 'strict') {
    throw new Error(`session cookie SameSite is ${session.sameSite}, not Strict — CSRF defence is weakened`);
  }
});

await step(page, 'workspace shell renders', async () => {
  // The connection sidebar is the anchor of the shell.
  const anchor = page.getByRole('button', { name: /new connection|add connection|\+/i }).first();
  await anchor.waitFor({ state: 'visible', timeout: 20_000 });
});

await step(page, 'open connection dialog', async () => {
  await page.getByRole('button', { name: /new connection|add connection/i }).first().click();
  await page.waitForTimeout(1200);
});

await step(page, 'create postgres connection', async () => {
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });

  // Labels are associated with their controls via Field's htmlFor/useId, so
  // getByLabel is the stable selector. Positional fallback keeps the test
  // working if a field is renamed.
  const fill = async (label, value, index) => {
    const byLabel = dialog.getByLabel(label, { exact: false }).first();
    if (await byLabel.isVisible({ timeout: 800 }).catch(() => false)) {
      await byLabel.fill(value);
      return;
    }
    await dialog.locator('input,select,textarea').nth(index).fill(value);
  };

  await fill('Name', 'PG smoke', 0);
  const engine = dialog.locator('select').first();
  await engine.selectOption('postgres').catch(() => {});
  // Reach Postgres by its compose service name, not host.docker.internal:
  // both app and database are containers on one network (PLAN 10.3).
  await fill('Host', 'postgres', 3);
  await fill('Port', '5432', 4);
  await fill('Username', 'dbadmin', 5);
  await fill('Password', 'dbadmin', 6);
  await fill('Database', 'sample', 8);

  const create = dialog.getByRole('button', { name: /^create$/i });
  if (await create.isDisabled()) {
    throw new Error('Create still disabled after filling required fields');
  }
});

await step(page, 'test connection succeeds', async () => {
  const dialog = page.locator('[role="dialog"]');
  const testBtn = dialog.getByRole('button', { name: /test connection/i }).first();
  await testBtn.click();
  await page.waitForTimeout(8000);
  const body = await dialog.innerText();
  if (!/postgresql\s*17|success|connected|rtt|ms/i.test(body)) {
    throw new Error(`no success indication: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
});

await step(page, 'save connection', async () => {
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: /^create$/i }).click();
  await page.waitForTimeout(3500);
  if (await dialog.isVisible().catch(() => false)) {
    throw new Error('dialog still open after Create');
  }
});

/**
 * Expand a tree row. Clicking the label selects; expansion is the disclosure
 * chevron, with ArrowRight as the keyboard fallback.
 */
async function expandRow(page, label) {
  const row = page.locator('[class*="tree"], [role="treeitem"], div')
    .filter({ hasText: new RegExp(`^\\s*${label}\\s`, 'i') })
    .last();
  const target = (await row.count()) ? row : page.getByText(label, { exact: false }).first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click({ timeout: 10_000 });
  await page.waitForTimeout(900);
  await page.keyboard.press('ArrowRight').catch(() => {});
  await page.waitForTimeout(2200);
}

await step(page, 'connect and open the object tree', async () => {
  await page.getByText('PG smoke', { exact: false }).first().click();
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText();
  // The tree lists DATABASES at its top level.
  if (!/sample/.test(body)) throw new Error('object tree did not list databases');
});

await step(page, 'expand database to its schemas', async () => {
  await expandRow(page, 'sample');
  const body = await page.locator('body').innerText();
  if (!/shop|public/i.test(body)) {
    throw new Error(`no schemas under sample: ${body.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
});

await step(page, 'expand schema to its tables', async () => {
  await expandRow(page, 'shop');
  // A schema groups its objects into folders (Tables / Views / Routines /
  // Sequences / Triggers), so the tables are one level deeper.
  await expandRow(page, 'Tables');
  await page.waitForTimeout(1500);
  const body = await page.locator('body').innerText();
  if (!/customers|orders|type_torture/i.test(body)) {
    throw new Error(`no tables under shop: ${body.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
});

await step(page, 'open customers table data', async () => {
  const t = page.getByText('customers', { exact: false }).first();
  await t.waitFor({ state: 'visible', timeout: 15_000 });
  await t.dblclick();
  await page.waitForTimeout(6000);
  const body = await page.locator('body').innerText();
  if (!/ada@example\.com/i.test(body)) throw new Error('grid did not render fixture rows');
});

await step(page, 'run a SQL query with lossless bigint', async () => {
  await page.getByRole('button', { name: /new query tab/i }).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  const cm = page.locator('.cm-content').first();
  await cm.waitFor({ state: 'visible', timeout: 12_000 });
  await cm.click();
  await page.keyboard.type('SELECT big, exact, nasty_text FROM shop.type_torture ORDER BY id');
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(7000);
  const body = await page.locator('body').innerText();
  if (!/9223372036854775807/.test(body)) {
    throw new Error('BIGINT not rendered losslessly in the grid');
  }
  if (!/12345678901234567890\.1234567890/.test(body)) {
    throw new Error('NUMERIC lost precision in the grid');
  }
});

await browser.close();

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
const report = { passed, failed: failed.length, results, consoleErrors: consoleErrors.slice(0, 40) };
writeFileSync('tests/e2e/report.json', JSON.stringify(report, null, 2));

console.log(`\n${passed}/${results.length} steps passed`);
if (consoleErrors.length) {
  console.log(`\nConsole errors (${consoleErrors.length}):`);
  for (const e of consoleErrors.slice(0, 15)) console.log('  -', e.slice(0, 220));
}
if (failed.length) {
  console.log('\nFailures:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
