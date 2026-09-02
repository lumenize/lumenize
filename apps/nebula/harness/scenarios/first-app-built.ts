/**
 * **A prompt typed into the rendered composer produces a built app in the preview.**
 *
 * The UI half of the codegen loop. `studio-codegen-rest` already drives one real turn at the API
 * level and `build-box` drives the container build — neither says a person can type a sentence and
 * watch an app appear. What is only covered here: the composer posts, the thread renders the turn
 * from its durable subscription, the empty-thread hint gets out of the way, no spurious failure
 * banner survives the wait, and the built `dist` actually reaches the preview iframe.
 *
 * ⚠️ **The universe and galaxy are provisioned by API, deliberately — and that is not the shortcut
 * it looks like.** This scenario's subject is the BUILD; `signup-to-first-app` owns the
 * create-through-UI path and would be duplicated (at the cost of a second email round trip) by
 * repeating it here. Everything from the login onward is still driven by clicking, and the login is
 * a real one: the emailed link `provisionAndLogin` returns is followed AS SENT in the browser, which
 * is legitimate rather than a second letter — magic links are deliberately multi-use inside their
 * TTL (the mail-scanner invariant), and that is exactly what the returned `link` exists for.
 *
 * Limbs, each isolated (`live.md` — mutation-check PER LIMB):
 *
 *  1. **The emailed link re-clicked in the browser lands a live session, and the app is reachable
 *     from the Universe page by clicking.** *Reds if the hand-off hint stops being written: Studio
 *     then refreshes against a path holding no cookie.*
 *  2. **The empty thread shows its hint, and the first post CLEARS it.** *Reds in both directions —
 *     a hint that never shows, or one pinned to the bottom of a conversation that has content. The
 *     visible-first half is the positive control: without it, "gone" would also pass on a hint that
 *     never rendered at all.*
 *  3. **A real turn completes and renders durably.** The wait is the assertion: a triggered turn
 *     runs detached server-side, so a broken model call is SILENCE, not an error (`live.md` — a hang
 *     reads as a slow boot). The durable reply is identified by its thought disclosure, which the
 *     TRANSIENT streaming bubble does not render — so this cannot pass on a stream that died
 *     uncommitted, which is the precise failure `turn-liveness` exists to catch.
 *  4. **No failure banner survives the completed turn.** *Reds on a `failed` that outlives its turn
 *     — the frozen-partial-reply hang.* A banner seen mid-turn is fine and expected: the idle window
 *     is deliberately short and self-heals, which is why this is asserted at the END only.
 *  5. **The preview serves the BUILT app.** Asserted on the server-injected `<base href>` rather
 *     than on "the iframe has a body" — a 404 and the SPA shell both have bodies, and only a dist
 *     served out of the Galaxy's own VFS carries that tag.
 *
 * ⚠️ **Model QUALITY is reported, never gated** (the discipline `studio-codegen-rest` sets). Whether
 * the generated app is any good is a different question with a different failure mode; what is
 * asserted here is that the pipeline a person drives end-to-end actually ran.
 *
 * Needs Docker (the build box) and a model lane — `WORKERS_AI_TOKEN` in `.dev.vars` selects the REST
 * transport, otherwise the `env.AI` binding under `wrangler dev` serves.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { provisionAndLogin } from '../../test/lib/email-login';

/** The build box is the subject — this one genuinely needs Docker. */
export const needsContainer = true;

const COMPOSER = 'Describe a change…';
const HINT = 'Connected. Describe the app you want to build.';
/** A cold turn is discriminator + generation + at least one container build cycle. */
const TURN_TIMEOUT_MS = 300_000;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const universe = `built-${crypto.randomUUID().slice(0, 8)}`;
  const appSlug = 'wishlist';
  const galaxy = `${universe}.${appSlug}`;
  const person = uniqueTestEmail();

  const browser = await launchChromium();
  const vite = await bootStudioVite(stack.baseUrl);
  try {
    // Provisioned THROUGH vite, so the link the server composes names the origin the browser will
    // follow it on (the Studio proxy forwards the real Host). Never re-pointed afterwards.
    const provisioned = await provisionAndLogin({
      baseUrl: vite.viteBaseUrl, scope: galaxy, email: person, testToken,
    });

    const inst = await instrumentedPage(browser);
    const { page } = inst;

    // ── LIMB 1: the same letter, clicked in the browser → Universe page → click into the app ───
    assert.ok(provisioned.link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the browsing origin as sent (got ${new URL(provisioned.link).origin})`);
    await page.goto(provisioned.link, { waitUntil: 'domcontentloaded' });
    // The membership was accepted during provisioning, so Home has a decision-free lone membership
    // and fast-forwards to the Universe page.
    await page.goto(`${vite.viteBaseUrl}/auth/${universe}/home`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(new RegExp(`//[^/]+/${universe}(?:[/?#]|$)`), { timeout: 30_000 });
    // ⚠️ Nothing to dismiss on the way in. The nickname is taken at the consent modal, so no
    // completion gate stands between arriving and working — this identity accepted programmatically
    // (`provisionAndLogin`), so it simply has none and its byline falls back to "Someone".
    // `signup-to-first-app` limb 7 is where the consent nickname's journey to a byline is asserted.
    const appRow = page.getByRole('button', { name: appSlug, exact: true });
    await appRow.waitFor({ state: 'visible', timeout: 30_000 });
    await appRow.click();
    await page.waitForURL(new RegExp(`//[^/]+/${universe}\\.${appSlug}(?:[/?#]|$)`), { timeout: 30_000 });

    const composer = page.getByPlaceholder(COMPOSER);
    try {
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'first-app-built-connect-failed');
      throw e;
    }
    const refusals = inst.failedRequests.filter(
      (r) => r.url.includes(`/auth/${galaxy}/refresh-token`) && (r.status === 401 || r.status === 'failed'),
    );
    assert.deepEqual(refusals, [], `Studio's refresh at the galaxy was refused: ${JSON.stringify(refusals)}`);
    console.error(`  ✓ limb 1 — clicked into ${galaxy}; Studio connected on a live session`);

    // ── LIMB 2: the hint is there, and posting clears it ───────────────────────────────────────
    // The visible half FIRST — it is the positive control for the "gone" assertion below.
    await page.getByText(HINT).waitFor({ state: 'visible', timeout: 20_000 });

    const prompt = 'Build me a wishlist app: add an item with a name, list the items, and let me remove one.';
    await composer.fill(prompt);
    await composer.press('Enter');
    // The poster's own message renders from the DURABLE subscription (there is no optimistic echo),
    // so this wait covers post → commit → fanout → render.
    await page.getByText(prompt).first().waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await page.getByText(HINT).count(), 0,
      'the empty-thread hint must be gone once the conversation has content');
    console.error('  ✓ limb 2 — the hint showed on an empty thread and cleared on the first post');

    // ── LIMB 3: a real turn completes and renders durably ─────────────────────────────────────
    // ⚠️ The THOUGHT DISCLOSURE, not a "Nebula" byline: the transient streaming bubble also carries
    // that byline, so waiting on it would pass on a stream that never committed.
    try {
      await page.getByText('💭 thought process').first()
        .waitFor({ state: 'visible', timeout: TURN_TIMEOUT_MS });
    } catch (e) {
      await captureArtifacts(inst, 'first-app-built-turn-never-landed');
      throw new Error(
        `no durable agent reply rendered within ${TURN_TIMEOUT_MS / 1000}s — the turn runs detached, ` +
        `so a broken model or build step is SILENCE here and this deadline is what makes it loud ` +
        `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    console.error('  ✓ limb 3 — a durable agent reply rendered in the thread');

    // ── LIMB 4: no failure banner survives the completed turn ──────────────────────────────────
    assert.equal(await page.getByText('No reply arrived').count(), 0,
      'a completed turn must leave no failure banner behind — a `failed` that outlives its turn is ' +
      'the frozen-partial-reply hang');
    console.error('  ✓ limb 4 — no failure banner survived the turn');

    // ── LIMB 5: the preview serves the BUILT app ──────────────────────────────────────────────
    const previewUrl = `${vite.viteBaseUrl}/app/${galaxy}.dev/`;
    const expectedBase = `<base href="/app/${galaxy}.dev/">`;
    let served: { status: number; body: string } | undefined;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const res = await page.context().request.get(previewUrl);
      const body = res.status() === 200 ? await res.text() : '';
      served = { status: res.status(), body };
      if (body.includes(expectedBase)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const capture = await captureArtifacts(inst, 'first-app-built');
    assert.ok(served && served.body.includes(expectedBase),
      `the preview did not serve a built app from the Galaxy's VFS — expected the injected ` +
      `${expectedBase} at ${previewUrl}, got status ${served?.status} (${served?.body.length ?? 0} bytes). ` +
      `The turn completed, so this is a build/serve failure rather than a codegen one.`);
    // The iframe is what the person actually looks at — assert it is pointed at the same place.
    const src = await page.locator('iframe[title="Preview"]').getAttribute('src');
    assert.ok(src?.startsWith(`/app/${galaxy}.dev/`),
      `the preview iframe must point at the app's dev star, got ${src}`);
    console.error(`  ✓ limb 5 — the preview serves the built app (${served.body.length} bytes)`);

    console.error(`  ── typed a sentence, got a built app (captures: ${capture.dir})`);
  } finally {
    await vite.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
