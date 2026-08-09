/**
 * Scope deletion through the RENDERED Studio — the Vue half of
 * `tasks/archive/nebula-star-founder-provisioning.md` Phase 1 (warn-don't-block, ADR-015).
 *
 * ⚠️ Why this must exist at the UI level, not as a registry test: `apps/nebula-studio-ui` has **zero
 * test files, no test script, no `vue-tsc`**, and is the sole `SKIP_PACKAGES` entry in
 * `scripts/type-check.sh`. The `blockedBy` → `affectedUsers` change rewrote the confirm handler, the
 * button's `:disabled`, and a `v-if="deletePlan.affectedUsers.total"` — and a stale field reference
 * reds in **no gate**, surfacing only as a runtime `TypeError` on the confirm screen. A registry-only
 * test passes while the button is dead. This is the test that proves it isn't.
 *
 * Gated `describe.runIf(HAS_DOCKER)` ONLY — deliberately not `&& HAS_AI_PATH`: an admin deleting a
 * scope touches no model. (`global-setup` boots the stack on `HAS_DOCKER` for the same reason; the
 * codegen scenarios keep their own `HAS_AI_PATH` gate.) Run it with
 * `npx vitest run --project ui-smoke`.
 *
 * Fixture discipline: this creates its OWN throwaway Galaxy and deletes that — it never touches the
 * shared `.dev` workspace the codegen smoke depends on.
 */
import { describe, it, expect, beforeAll, afterAll, inject } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { HAS_DOCKER } from './gates';
import { resolveChromiumExecutable, loginToStudio, openScopeManager } from './helpers';

const TEST_SCOPE = 'test-u0.test-g0.dev';
const ADMIN_EMAIL = 'test@lumenize.io';
/** The universe the admin owns — the parent under which the throwaway Galaxy is created. */
const UNIVERSE = 'test-u0';
/**
 * Both tests below are `it.skip` pending a login path into a `.dev` scope, so the `beforeAll` skips the expensive
 * browser + real-email login boot too (a failing hook would red the suite instead of showing
 * `↓ skipped`). Flip to `false` in the same commit that un-skips them.
 */
const LANE_BLOCKED_ON_DEV_SCOPE_LOGIN = true;

describe.runIf(HAS_DOCKER)('Scope deletion through the rendered Studio (wrangler dev + Docker)', () => {
  let browser: Browser;
  let authed: { ctx: BrowserContext; page: Page } | null = null;

  beforeAll(async () => {
    if (LANE_BLOCKED_ON_DEV_SCOPE_LOGIN) return;
    browser = await chromium.launch({ executablePath: resolveChromiumExecutable() });
    authed = await loginToStudio({
      browser,
      viteBaseUrl: inject('viteBaseUrl'),
      testToken: inject('emailTestToken'),
      scope: TEST_SCOPE,
      email: ADMIN_EMAIL,
    });
  }, 120_000);

  afterAll(async () => {
    await authed?.ctx.close();
    await browser?.close();
  });

  // ⛔ SKIPPED — blocked on the SAME lane-wide login break, not on anything in this scenario.
  // LOGIN NEVER MINTS (post-surrogate-sub) and nothing provisions `TEST_SCOPE`, so the magic-link
  // consume returns `302 /app?error=invalid_token` with no Set-Cookie and the Studio never reaches
  // `connected` (proven 2026-07-25 — see smoke.test.ts's skip comment for the full trace).
  // ⚠️ **CORRECTED 2026-07-25 while building Phase 2: `claim-star` does NOT unblock this.** The lane
  // logs in AT `test-u0.test-g0.dev`, and `.dev` is on the RESERVED list `claim-star` itself adds —
  // it refuses that slug by design (a stranger founding the user-developer's own Studio workspace is
  // exactly what the list prevents). A `.dev` scope has no star-scoped admin by construction, so an identity
  // reaches it only by (a) logging in at an ANCESTOR the covering admin holds — but `refreshCookie` sets
  // `Path=/auth/{scope}`, so a universe login's cookie is not sent to `/auth/{u}.{g}.dev/refresh-token`
  // — or (b) an INVITE into the scope (tasks/nebula-auth-identity-mint.md). Which one is a design
  // question, tracked in tasks/archive/nebula-star-founder-provisioning.md § Phase 2.
  // ⛔ Do NOT unblock by dropping `dev` from the reserved list.
  // The assertions below are the real Phase-1 UI contract and are left intact.
  it.skip('an admin deletes a scope through the confirm screen — the button is LIVE and the row goes', async () => {
    const page = authed!.page;
    const slug = `del-${Date.now().toString(36)}`;
    const target = `${UNIVERSE}.${slug}`;

    await openScopeManager(page);

    // Create a throwaway Galaxy to delete (never the shared `.dev` workspace).
    await page.getByRole('button', { name: /Galaxy/ }).first().click();
    await page.getByPlaceholder('galaxy-slug (your app)').fill(slug);
    await page.getByRole('button', { name: /^Add$/ }).click();
    await page.getByText(target, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });

    // Open its delete confirm (the per-row trash button).
    const row = page.locator('div', { has: page.getByText(target, { exact: true }) }).last();
    await row.getByTitle('Delete').click();

    // ⚠️ Capable-of-failing on the RENAME: this heading only renders inside `v-if="deletePlan"`, and
    // the sibling `v-if="deletePlan.affectedUsers.total"` evaluates on the same render — a stale
    // `blockedBy` reference throws a TypeError here and the confirm screen never appears.
    await page.getByText(`Delete ${target}?`).waitFor({ state: 'visible', timeout: 30_000 });
    // An empty scope → the safe-to-wipe branch of the warning block (proves `affectedUsers` resolved).
    await page.getByText('No other users — safe to wipe.').waitFor({ state: 'visible' });

    // ⚠️ THE Phase-1 assertion: the button is ENABLED. Before warn-don't-block it was bound to
    // `:disabled="busy || deletePlan.blockedBy.length > 0"` and the handler early-returned on the
    // same value — reds against that code.
    const confirmBtn = page.getByRole('button', { name: /Delete permanently/ });
    await expect.poll(() => confirmBtn.isEnabled(), { timeout: 10_000 }).toBe(true);

    await confirmBtn.click();

    // The row is gone from the hierarchy → the delete round-tripped through the real Worker.
    await page.getByText(target, { exact: true }).waitFor({ state: 'detached', timeout: 60_000 });
    expect(await page.getByText(`Delete ${target}?`).count()).toBe(0);
  }, 180_000);

  // ⛔ DEFERRED — needs a second identity attached to the target, and there is no way to create one:
  // the Studio has no invite affordance and `nebula-client` exposes no invite method. Deliberately
  // NOT satisfied with an out-of-band registry seed: a test-only fixture in this lane is exactly the
  // ossifying stand-in `workflow.md` warns about ("prefer `it.skip` over an ossifying stand-in —
  // skipping defers ONE test; a stand-in creates an artifact N future tests anchor to").
  //
  // UN-SKIP when `tasks/nebula-auth-identity-mint.md` lands (an admin invites a peer who becomes an
  // admin at the invited scope) — that file carries the acceptance criterion for this deferral.
  // The registry-level equivalent IS covered today: `nebula-auth-registry.test.ts`
  // "warning: another user on the target is reported, and the delete still succeeds" +
  // `identity-mint-point.test.ts` "a genuinely shared scope is deleted, not refused".
  it.skip('deletes a scope WITH another user attached, showing the bounded warning', async () => {
    // Invite a second user into `target`, then assert: the confirm screen shows
    // "Warning — 1 other user will lose access: {target} (peer@…)", the Delete button is still
    // ENABLED, and the delete completes.
  });
});
