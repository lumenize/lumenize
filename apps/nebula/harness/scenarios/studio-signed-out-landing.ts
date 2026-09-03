/**
 * **Signed out, Studio is ONE landing — no chat rail beside a stage with nothing to say.**
 *
 * The signed-out shell used to render the workspace layout with the session missing: a chat rail
 * whose footer held "Sign in", and a stage telling you to "Sign in on the left". Larry's first
 * hand-drive (2026-09-02) named it — the split makes no sense when there is nothing to chat with.
 * The rail now exists only inside a workspace on a live session, and the landing carries the sign-in
 * controls with the three-level welcome.
 *
 * Limbs, each isolated (`live.md` — per limb):
 *
 *  1. **Bare `/` signed out renders the landing and NOT the rail.** *Reds if the rail's condition
 *     regresses to `!connected || …`: the "Nebula Studio" rail header and the composer come back.*
 *  2. **A workspace URL signed out renders the same landing.** The other branch of the rail's
 *     condition — a scope in the URL must not summon the rail before there is a session.
 *  3. **"Sign in" reaches the auth SPA's login.** Studio has no login of its own; the button is the
 *     front door's only wiring from here. *Reds if `goToLogin` points anywhere else.*
 *  4. **Bare `/` is clean, and a stranger at a workspace URL costs EXACTLY one 401** — the session
 *     probe (`/auth/{scope}/refresh-token`): the refresh cookie is HttpOnly, so asking is the only
 *     way the shell can learn there is no session, and the browser logs the answer as a console
 *     error. *Reds against any other failed request or console error — and against the probe going
 *     missing, which would mean a returning person's session is no longer found on arrival.*
 *
 * `needsContainer = false` — the shell only, never a build.
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';

export const needsContainer = false;

export async function run(stack: DevStack): Promise<void> {
  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    const inst = await instrumentedPage(browser);
    const { page } = inst;
    const rail = () => page.getByRole('heading', { name: 'Nebula Studio' });
    const composer = () => page.getByPlaceholder('Describe a change…');

    // ── LIMB 1: bare `/` is the landing, alone ─────────────────────────────────────────────────
    await page.goto(`${vite.viteBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('landing').waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('heading', { name: 'Welcome to Nebula' }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /^Sign in$/ }).waitFor({ state: 'visible' });
    assert.equal(await rail().count(), 0, 'signed out, the chat rail must not render');
    assert.equal(await composer().count(), 0, 'signed out, there is no composer');
    const capture = await captureArtifacts(inst, 'studio-signed-out-landing');
    console.error(`  ✓ limb 1 — bare / renders the landing without the rail (${capture.screenshotPath})`);

    // ── LIMB 2: a workspace URL, signed out, is still the landing ──────────────────────────────
    const stranger = `nobody-${crypto.randomUUID().slice(0, 6)}.app`;
    await page.goto(`${vite.viteBaseUrl}/${stranger}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('landing').waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await rail().count(), 0, 'a workspace URL must not summon the rail before a session');
    assert.equal(await composer().count(), 0, 'a workspace URL signed out has no composer');
    console.error('  ✓ limb 2 — a workspace URL signed out renders the landing, not the rail');

    // ── LIMB 3: Sign in is the front door ──────────────────────────────────────────────────────
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForURL(/\/auth\/login$/, { timeout: 20_000 });
    await page.getByPlaceholder('you@example.com').waitFor({ state: 'visible', timeout: 20_000 });
    console.error('  ✓ limb 3 — Sign in lands on /auth/login with the form rendered');

    // ── LIMB 4: exactly the session probe, nothing else ────────────────────────────────────────
    // Across all three pages (limb 1's capture above showed bare `/` costs nothing). The probe is
    // the one 401 a stranger's workspace URL is allowed; its absence is the other defect.
    await captureArtifacts(inst, 'studio-signed-out-landing-login');
    assert.deepEqual(
      inst.failedRequests,
      [{ url: `${vite.viteBaseUrl}/auth/${stranger}/refresh-token`, status: 401, method: 'POST' }],
      `expected exactly the session probe's 401, got ${JSON.stringify(inst.failedRequests)}`,
    );
    assert.deepEqual(
      inst.consoleErrors,
      ['Failed to load resource: the server responded with a status of 401 (Unauthorized)'],
      `expected only the browser's line for that 401, got ${JSON.stringify(inst.consoleErrors)}`,
    );
    console.error('  ✓ limb 4 — bare / is clean; the stranger\'s workspace URL cost exactly the session probe');
  } finally {
    await vite.close();
    await browser.close();
  }
}
