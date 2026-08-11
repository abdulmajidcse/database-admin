/**
 * Account flows through the browser (PLAN §9.2).
 *
 * Covers the thing the API tests cannot: that a person can actually get from
 * the sign-in screen to a working workspace on a brand new account, and that
 * the new account starts empty rather than inheriting anyone's connections.
 *
 * The new username is randomised per run. It has to be: accounts persist and
 * there is no delete, so a fixed name makes the second run hit "already taken"
 * and fail the very step it is meant to prove. The leftover accounts are inert
 * — no connections, no vault contents — but they do accumulate, so clear them
 * out of accounts.json if a clean install matters.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const APP = process.env.APP_URL ?? 'http://app:3456';
const OWNER = { user: process.env.DBADMIN_USER ?? 'demo', pass: process.env.DBADMIN_PASSWORD ?? 'demo-account-passphrase' };
const NEW = { user: process.env.NEW_USER ?? `signup-probe-${randomUUID().slice(0, 8)}`, pass: 'signup-probe-pass' };

// Saved connections the owner account is expected to have. Placeholders by
// default so this file carries nobody's real infrastructure names; set
// DBADMIN_CONNECTIONS="One,Two,Three" to match what the machine actually has.
const CONNECTIONS = (process.env.DBADMIN_CONNECTIONS ?? 'Demo Postgres,Demo MySQL,Demo Redis')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SHOTS = 'tests/e2e/screenshots';
mkdirSync(SHOTS, { recursive: true });

const results = [];
async function step(page, name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${Date.now() - t}ms)`);
  } catch (err) {
    results.push({ name, ok: false, error: String(err?.message ?? err) });
    console.log(`  FAIL  ${name} — ${err?.message ?? err}`);
    await page.screenshot({ path: `${SHOTS}/account-fail-${name.replace(/\W+/g, '-')}.png` }).catch(() => {});
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

console.log(`\nAccount flows against ${APP}\n`);

await step(page, 'sign-in screen offers account creation', async () => {
  await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.getByRole('button', { name: /^sign in$/i }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByRole('button', { name: /create one/i }).waitFor({ state: 'visible', timeout: 5_000 });
});

await step(page, 'switching to the create form and back', async () => {
  await page.getByRole('button', { name: /create one/i }).click();
  await page.getByRole('button', { name: /create account/i }).waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await page.getByRole('button', { name: /create one/i }).waitFor({ state: 'visible', timeout: 5_000 });
});

await step(page, 'create a second account', async () => {
  await page.getByRole('button', { name: /create one/i }).click();
  await page.getByLabel(/username/i).fill(NEW.user);
  await page.getByLabel(/^password$/i).fill(NEW.pass);
  await page.getByLabel(/confirm password/i).fill(NEW.pass);
  const create = page.getByRole('button', { name: /create account/i });
  if (await create.isDisabled()) throw new Error('Create account disabled with every field filled');
  await create.click();
  // The workspace is the proof: the gate only lets go once signed in.
  await page.getByRole('button', { name: /new connection|add connection/i }).first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
});

await step(page, 'the new account sees no existing connections', async () => {
  const body = await page.locator('body').innerText();
  for (const name of CONNECTIONS) {
    if (body.includes(name)) throw new Error(`new account can see "${name}" — connections are not private`);
  }
});

await step(page, 'a taken username is refused with a clear message', async () => {
  const res = await page.request.post(`${APP}/api/account/register`, {
    data: { username: OWNER.user, password: 'irrelevant-but-long' },
    headers: { origin: APP },
  });
  if (res.status() !== 409) throw new Error(`expected 409, got ${res.status()}`);
  const body = await res.json();
  if (!/already taken/i.test(body.error ?? '')) throw new Error(`unhelpful message: ${body.error}`);
});

await step(page, 'sign out returns to the sign-in screen', async () => {
  await page.getByRole('button', { name: /sign out/i }).first().click();
  await page.getByRole('button', { name: /^sign in$/i }).waitFor({ state: 'visible', timeout: 20_000 });
});

await step(page, 'the original account still has its connections', async () => {
  await page.getByLabel(/username/i).fill(OWNER.user);
  await page.getByLabel(/password/i).first().fill(OWNER.pass);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  for (const name of CONNECTIONS) {
    await page.getByText(name, { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
  }
  await page.screenshot({ path: `${SHOTS}/account-flows.png` });
});

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} steps passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
