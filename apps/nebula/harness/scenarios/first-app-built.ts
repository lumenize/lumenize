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
 *     served out of the Galaxy's own VFS carries that tag. And the build REPLY refreshed the
 *     iframe (`?t=`), the positive control for limb 6.
 *  6. **A reloaded client renders the built app with NO preview-ready push.** The initial-load
 *     cue is deleted; the frame's `<base href>` proves the dist served cold, and the bare src
 *     proves nothing pushed. *Reds if the cue comes back, or if a cold load stops serving.*
 *  7. **A fresh Galaxy carries its own guidance layer.** The seeded `AGENTS.md` and the one-line
 *     `CLAUDE.md`, read through the chat-floor `readSource` entry BEFORE the model's first turn.
 *     *Reds if the seed leaves the scaffold, or the entry stops answering a chat-`write` caller.*
 *  8. **A plain question is answered through the single path, and every warm is torn down.**
 *     Asserted on the Worker's own `warm`/`teardown` markers off stdio, paired per turn, with the
 *     turn-level teardown isolated after the build turn's last job report; `docker ps` is the
 *     outside witness. Local venue only — a deployed target captures no stdio, so the pairing
 *     is reported as not observable there. *Reds if a teardown stops running, or the reply never lands.*
 *
 * ⚠️ **Model QUALITY is reported, never gated** (the discipline `studio-codegen-rest` sets). Whether
 * the generated app is any good is a different question with a different failure mode; what is
 * asserted here is that the pipeline a person drives end-to-end actually ran.
 *
 * Needs Docker (the build box) and a model lane — `WORKERS_AI_TOKEN` in `.dev.vars` selects the REST
 * transport, otherwise the `env.AI` binding under `wrangler dev` serves.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { Galaxy, Snapshot } from '@lumenize/nebula';
import { DEFAULT_CHAT_ID, deriveKind } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, connectDriver } from '../lib/harness';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { provisionAndLogin } from '../../test/lib/email-login';

/** The build box is the subject — this one genuinely needs Docker. */
export const needsContainer = true;
/** The Worker's warm, teardown, build and write markers, for limb 8 and the EXPLORATORY limb
 *  (g) below — read back off the dev stack's stdio; four namespaces only, so the boot is not
 *  flooded. */
export const bootVars = { DEBUG: 'nebula.Galaxy.warm,nebula.Galaxy.teardown,nebula.Galaxy.build,nebula.Galaxy.writeSource,nebula.Galaxy.stream' };

/** The Galaxy's own markers, parsed leniently off the dev stack's stdio — the log objects are
 *  pretty-printed JSON, one per `console.debug`; anything that is not one of ours is skipped. */
type GalaxyMarker = { ns: string; message: string; at: number; idx: number; instanceName?: string };
/** Every `nebula.Galaxy.*` marker off the dev stack's stdio, in EMISSION order (`idx`) —
 *  two markers logged in one millisecond keep their order, which a timestamp cannot say. */
function galaxyMarkers(raw: string): GalaxyMarker[] {
  const markers: GalaxyMarker[] = [];
  for (const block of raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\n(?=\{\n)/)) {
    const end = block.indexOf('\n}');
    if (end < 0) continue;
    try {
      const obj = JSON.parse(block.slice(0, end + 2)) as { namespace?: string; message?: string; timestamp?: string; data?: { instanceName?: string } };
      if (obj.namespace?.startsWith('nebula.Galaxy.') && obj.timestamp) {
        markers.push({ ns: obj.namespace, message: obj.message ?? '', at: Date.parse(obj.timestamp), idx: markers.length, instanceName: obj.data?.instanceName });
      }
    } catch { /* not one of ours */ }
  }
  return markers;
}

const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

/** The latest durable agent reply's manifest — what the model's turn actually did — for
 *  attributing a red: a stop with no successful build is the model's; a refreshed preview
 *  beside a 404 is a dist that never arrived (`tasks/backlog.md`'s `build-box` row). */
async function latestAgentManifest(stack: DevStack, galaxy: string, session: { accessToken: string; sub: string }): Promise<string> {
  const driver = await connectDriver(stack, { scope: galaxy, session });
  try {
    using sub = driver.client.resources.subscribeQuery(chatQuery); await sub.ready;
    const replies: Array<{ at: string; v: Record<string, unknown> }> = [];
    for (const rid of sub.resourceIds) {
      const snap = await driver.client.resources.read('Message', rid) as Snapshot | null;
      if (snap && deriveKind(snap.meta.actingToken) === 'agent') replies.push({ at: String((snap.meta as { validFrom?: string }).validFrom ?? ''), v: snap.value as Record<string, unknown> });
    }
    const last = replies.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (!last) return 'no agent reply found';
    const cg = last.v.codegen as { stop?: string; rounds?: number; appliedPaths?: string[]; toolCalls?: Array<{ name: string; result?: unknown; error?: string }> } | undefined;
    const builds = (cg?.toolCalls ?? []).filter((t) => t.name === 'build');
    const lastBuild = builds.at(-1);
    const r = lastBuild?.result as { preview?: { refreshed?: boolean; why?: string }; steps?: unknown } | undefined;
    return `stop=${cg?.stop} rounds=${cg?.rounds} applied=${(cg?.appliedPaths ?? []).join(',') || '-'} builds=${builds.length}` +
      ` reply=${JSON.stringify(String(last.v.content ?? '').slice(0, 200))}` +
      (lastBuild ? (lastBuild.error ? ` lastBuild=error: ${lastBuild.error}` : ` lastBuild.preview=${JSON.stringify(r?.preview ?? null)} steps=${String(JSON.stringify(r?.steps ?? null)).slice(0, 400)}`) : '');
  } finally {
    driver.dispose();
  }
}

const COMPOSER = 'Describe a change…';
const HINT = 'Connected. Describe the app you want to build.';
/** A cold turn is generation + up to 32 rounds with container builds; the
 *  server's own generation deadline is 14 min, so this tracks it plus margin — a turn that
 *  legitimately runs long must not read as a hung one. */
const TURN_TIMEOUT_MS = 900_000;

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
    // ⚠️ ONE navigation: the link lands on Home by itself, and a second `goto` would cancel this
    // page's in-flight bootstrap. The membership was accepted during provisioning, so Home has a
    // decision-free lone membership and fast-forwards to the Universe page — waited on below, which
    // is an auto-waiting assertion rather than a delay.
    await page.goto(provisioned.link, { waitUntil: 'domcontentloaded' });
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

    // The Galaxy layer's SEED, read before the model's first turn can touch it (limb 7 asserts
    // on it below): the platform layer invites the model to keep `AGENTS.md` current, so a
    // read after the turn would gate the scaffold on the model.
    const seeded = await (async () => {
      const driver = await connectDriver(stack, {
        scope: galaxy, session: { accessToken: provisioned.accessToken, sub: provisioned.sub },
      });
      try {
        return {
          agents: await driver.client.lmz.callAsync('GALAXY', galaxy, driver.client.ctn<Galaxy>().readSource('AGENTS.md')) as string,
          claude: await driver.client.lmz.callAsync('GALAXY', galaxy, driver.client.ctn<Galaxy>().readSource('CLAUDE.md')) as string,
        };
      } finally {
        driver.dispose();
      }
    })();

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

    // ── LIMB 3: a real turn completes and renders durably — and stays HEALTHY while it runs ────
    // ⚠️ The THOUGHT DISCLOSURE, not a "Nebula" byline: the transient streaming bubble also carries
    // that byline, so waiting on it would pass on a stream that never committed.
    //
    // ⚠️ WATCH THE WHOLE TURN, not the settled end. Two defects are TRANSIENTS that a post-turn
    // assertion cannot see (testing.md's self-heal trap):
    //  (a) the failure banner painting mid-turn — the idle window elapsing on a turn that is alive.
    //      This is the flash seen on the first hand drive, and the server heartbeat exists to make
    //      it impossible (`turn-heartbeat.ts` beats through the silent model call and build);
    //  (b) an EMPTY streaming bubble — a keepalive carries no text, and the client hook must re-arm
    //      without painting it. Either one self-heals seconds later and leaves a green end state.
    //  (c) the spinner must MOVE: while the turn is silent the only feedback is the elapsed
    //      counter on the thinking bubble, so two samples of it ≥2 s apart must differ.
    let thinkingFirst: { text: string; at: number } | undefined;
    let thinkingMoved = false;
    //  (d) the turn STREAMS: the strip's tail must take at least two distinct values (live deltas,
    //      not one lump when the model returns), and clicking it mid-stream must open a transcript
    //      longer than the tail — the unreadable scroll by default, readable on request.
    const tailsSeen = new Set<string>();
    let transcriptChecked = false;
    let lastTailAt = 0;
    const turnStartedAt = Date.now();
    const liveWatch = (async () => {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await page.getByText('💭 thought process').count() > 0) return;
        const tailEl = page.getByTestId('stream-tail');
        if (await tailEl.count() > 0) {
          const tail = (await tailEl.first().textContent())?.trim() ?? '';
          if (tail && !tailsSeen.has(tail)) { tailsSeen.add(tail); lastTailAt = Date.now(); }
          // Judge the modal only once the strip is a TAIL (the leading ellipsis marks truncation
          // at 80 chars): sampled earlier, the transcript IS the strip, and 75 vs 75 reads as a
          // modal that holds nothing more (the 2026-09-05 sweep red).
          if (!transcriptChecked && tailsSeen.size >= 2 && tail.startsWith('…')) {
            transcriptChecked = true;
            await page.getByTestId('stream-strip').first().click();
            const transcript = page.getByTestId('stream-transcript');
            await transcript.waitFor({ state: 'visible', timeout: 5_000 });
            const full = (await transcript.textContent())?.trim() ?? '';
            if (full.length <= tail.replace(/^…/, '').length) {
              await captureArtifacts(inst, 'first-app-built-transcript-short');
              throw new Error(`the transcript modal must hold MORE than the strip's tail (${full.length} vs ${tail.length} chars)`);
            }
            await page.getByTestId('stream-transcript-close').click();
          }
        }
        const thinking = page.getByTestId('turn-thinking');
        if (await thinking.count() > 0) {
          const text = (await thinking.first().textContent())?.trim() ?? '';
          if (!thinkingFirst) thinkingFirst = { text, at: Date.now() };
          else if (!thinkingMoved && Date.now() - thinkingFirst.at >= 2_000) {
            if (text === thinkingFirst.text) {
              await captureArtifacts(inst, 'first-app-built-spinner-frozen');
              throw new Error(`the thinking bubble did not MOVE in 2 s ("${text}") — a silent turn shows a frozen spinner`);
            }
            thinkingMoved = true;
          }
        }
        if (await page.getByText('No reply arrived').count() > 0) {
          await captureArtifacts(inst, 'first-app-built-failed-flash');
          throw new Error('the failure banner PAINTED during a live turn — the idle window elapsed on a ' +
            'turn that was still running, which the server heartbeat exists to prevent ' +
            `(${((Date.now() - turnStartedAt) / 1000).toFixed(0)} s into the turn; ${tailsSeen.size} distinct tails seen; ` +
            `last new tail ${lastTailAt ? `${((Date.now() - lastTailAt) / 1000).toFixed(0)} s ago` : 'never'})`);
        }
        const emptyBubbles = await page.locator('.chat-start .chat-bubble')
          .evaluateAll((els) => els.filter((e) => (e.textContent ?? '').trim() === '').length);
        if (emptyBubbles > 0) {
          await captureArtifacts(inst, 'first-app-built-empty-bubble');
          throw new Error('an EMPTY assistant bubble rendered mid-turn — a keepalive was painted as content');
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    // Handled at creation: the watch can throw long before the flow below awaits it, and an
    // unhandled rejection kills the process — skipping the harness's catch, its stdio dump
    // and its cleanup, which is how every banner red before 2026-09-06 lost its evidence.
    liveWatch.catch(() => { /* re-thrown by the await below */ });
    try {
      await page.getByText('💭 thought process').first()
        .waitFor({ state: 'visible', timeout: TURN_TIMEOUT_MS });
      await liveWatch;
    } catch (e) {
      if (e instanceof Error && /PAINTED|EMPTY assistant bubble|did not MOVE|transcript modal/.test(e.message)) throw e;
      await captureArtifacts(inst, 'first-app-built-turn-never-landed');
      throw new Error(
        `no durable agent reply rendered within ${TURN_TIMEOUT_MS / 1000}s — the turn runs detached, ` +
        `so a broken model or build step is SILENCE here and this deadline is what makes it loud ` +
        `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    assert.ok(tailsSeen.size >= 2,
      `the reply must STREAM — the strip's tail took ${tailsSeen.size} distinct value(s); one or none means ` +
      'the text landed whole when the model returned, which is the pre-streaming shape');
    assert.ok(transcriptChecked, 'the transcript modal was never exercised — the strip never had two tails to click between');
    console.error(`  ✓ limb 3 — a durable agent reply rendered, the turn stayed healthy, and it STREAMED ` +
      `(${tailsSeen.size} tails; transcript read mid-stream)` +
      (thinkingMoved ? ' (spinner ticked)' : ' (thinking phase too short to sample motion)'));

    // ── LIMB 4: no failure banner survives the completed turn ──────────────────────────────────
    assert.equal(await page.getByText('No reply arrived').count(), 0,
      'a completed turn must leave no failure banner behind — a `failed` that outlives its turn is ' +
      'the frozen-partial-reply hang');
    // The agent's reply wears TWO faces: Nebula (the actor) in front, the person it ran for behind —
    // `deriveParticipants` order, actor first. A single face here would mean the act chain was
    // flattened away, which is the attribution ADR-016 exists to keep.
    const agentChat = page.locator('div.chat', { has: page.locator('[data-testid="byline"]', { hasText: /^Nebula/ }) }).first();
    await agentChat.waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await agentChat.locator('[data-testid="party-avatar"]').count(), 2,
      'an act-bearing message must stack two faces: the actor and the subject');
    assert.equal(await agentChat.locator('[data-testid="party-avatar"].z-10').getAttribute('data-name'), 'Nebula',
      'the ACTOR (Nebula) must be the face in front');
    console.error('  ✓ limb 4 — no failure banner survived the turn; Nebula\'s reply stacks actor over subject');

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
    // The build turn's manifest, printed on every run: on a red it says whether a build ever
    // succeeded (a stop with no refreshed preview is the model's) or the dist never arrived
    // (refreshed, then a 404); on a green it is the record of what the turn did.
    const manifest = await latestAgentManifest(stack, galaxy, { accessToken: provisioned.accessToken, sub: provisioned.sub })
      .catch((e: unknown) => `manifest unavailable: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  · the build turn's reply: ${manifest}`);
    if (!(served && served.body.includes(expectedBase))) {
      assert.fail(`the preview did not serve a built app from the Galaxy's VFS — expected the injected ` +
        `${expectedBase} at ${previewUrl}, got status ${served?.status} (${served?.body.length ?? 0} bytes). ` +
        `The turn completed; its reply says ${manifest}`);
    }
    // The iframe is what the person actually looks at — assert it is pointed at the same place.
    const src = await page.locator('iframe[title="Preview"]').getAttribute('src');
    assert.ok(src?.startsWith(`/app/${galaxy}.dev/`),
      `the preview iframe must point at the app's dev star, got ${src}`);
    // POSITIVE CONTROL for limb 6: a refresh bumps the src with a `?t=` cache-buster. Driven by
    // the Studio's own Reload control rather than by the build reply — the reply refreshes only a
    // findings-free build (the model may or may not override), so waiting on it made this limb
    // red or green on the model's findings, not on the code under test.
    const reloadButton = page.getByTitle('Reload preview');
    await reloadButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => !(document.querySelector('button[title="Reload preview"]') as HTMLButtonElement | null)?.disabled,
      undefined, { timeout: 60_000, polling: 250 });
    await reloadButton.click();
    await page.waitForFunction(
      () => (document.querySelector('iframe[title="Preview"]')?.getAttribute('src') ?? '').includes('?t='),
      undefined, { timeout: 30_000, polling: 250 },
    );
    console.error(`  ✓ limb 5 — the preview serves the built app (${served.body.length} bytes); a refresh bumps the iframe src`);

    // ── LIMB 6: a fresh client renders the built app with NO preview-ready push ──────────────
    // The initial-load cue (`warmPreview`) is deleted: `dist/` serves from the Galaxy's VFS, so
    // a reload's iframe carries the built app on its own. Asserted on the RENDERED document —
    // the server-injected `<base href>` inside the frame, which only a served dist carries — and
    // on the src staying the bare path: a push would have re-bumped it with `?t=` (limb 5 is the
    // positive control for that shape), and the deleted cue was the one thing that ever pushed
    // on a fresh client. *Reds if the cue comes back (the src gains `?t=` with no build), or if
    // the preview stops serving on a cold load.*
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    const frameBase = page.frameLocator('iframe[title="Preview"]').locator('base').first();
    await frameBase.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await frameBase.getAttribute('href'), `/app/${galaxy}.dev/`,
      'the reloaded preview frame must render the built app (the injected <base href>)');
    // Settle long enough for any push to have landed (a build reply is sub-second on delivery),
    // then read the src the frame rendered from.
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(await page.locator('iframe[title="Preview"]').getAttribute('src'), `/app/${galaxy}.dev/`,
      'a fresh client gets NO preview-ready push — the iframe src stays the bare dev path');
    console.error('  ✓ limb 6 — a reloaded client renders the built app with no preview-ready push');

    // ── LIMB 7: a fresh Galaxy carries its own guidance layer, read back through the client ──
    // The scaffold seeds `AGENTS.md` (the Galaxy layer of the guidance tree) into every new
    // Workspace; `seeded` is that seed, read above through the chat-floor `readSource` entry
    // on the identity that built the app, BEFORE the model's first turn. *Reds if the seed
    // stops riding the scaffold, or if the entry stops answering a chat-`write` caller.*
    assert.ok(seeded.agents.startsWith('# Guidance for this app'),
      `a fresh Galaxy must carry the seeded AGENTS.md — got ${JSON.stringify(seeded.agents.slice(0, 60))}`);
    assert.equal(seeded.claude, '@AGENTS.md\n', 'CLAUDE.md is exactly the one-line import');
    console.error('  ✓ limb 7 — the fresh Galaxy reads its own seeded AGENTS.md back through the client');

    // ── LIMB 8: a plain question after the build gets its reply through the SAME path, and
    //            every warm this run fired was followed by a teardown ────────────────────────
    // There is one assembly for every turn; a question ends the loop with the reply as the
    // answer. Only a write warms, so a question's turn starts no box and a bare "no box
    // running afterwards" would pass with the teardown deleted. What is asserted instead is
    // the pairing, per turn, on the Worker's own markers: the BUILD turn certainly warmed
    // (the positive control that the markers are seen at all), and each of its warms is
    // followed by a teardown; the question's turn is held to the same pairing IF it warmed.
    // Docker is then the outside witness: no build box this run started is left up.
    // *Reds if the teardown stops running on any turn, or if the question's reply never lands.*
    const boxes = () => execSync("docker ps --format '{{.Names}}'", { encoding: 'utf8' })
      .split('\n').filter((n) => n.startsWith('workerd-nebula-Galaxy-') && !n.endsWith('-proxy'));
    const askedAt = Date.now();
    const question = 'What does this app do so far? Answer in a sentence; do not change any code.';
    await composer.fill(question);
    await composer.press('Enter');
    await page.getByText(question).first().waitFor({ state: 'visible', timeout: 60_000 });
    // A second durable reply — the disclosure count goes to 2 — inside a cold-turn budget.
    await page.waitForFunction(
      () => document.body.innerText.split('💭 thought process').length - 1 >= 2,
      undefined, { timeout: TURN_TIMEOUT_MS, polling: 500 },
    );
    // Give the turn's `finally` a moment to log its teardown, then read the markers once.
    await new Promise((r) => setTimeout(r, 3_000));
    // The Worker's stdio is captured on a LOCAL stack only (`DevStack.logs`); a deployed target
    // (`HARNESS_TARGET_URL`) shows neither the markers nor, through `docker ps`, its containers,
    // so there the pairing is reported as not observable and the reply half — the second
    // disclosure above — is what the venue asserts (`live.md` § *Two venues, one registry*).
    // Until the observability tail Worker exposes deployed logs — `tasks/backlog.md` § *Testing
    // & Quality* carries the re-merge — after which `DevStack.logs` gets a deployed reader.
    const stdio = stack.logs?.();
    // This Galaxy's markers only, on the stamp every marker carries (`testing.md`).
    const markers = galaxyMarkers(stdio ?? '').filter((m) => m.instanceName === galaxy);
    // A warm is the FIRED marker, not the namespace: a failed start warns there without `by`.
    const warmsOf = (ms: GalaxyMarker[]) => ms.filter((m) => m.ns === 'nebula.Galaxy.warm' && m.message === 'container warm fired');
    const pairedThrough = (from: number, to: number): { warms: number; unpaired: number } => {
      const inWindow = markers.filter((m) => m.at >= from && m.at <= to);
      const warms = warmsOf(inWindow);
      const unpaired = warms.filter((w) => !inWindow.some((t) => t.ns === 'nebula.Galaxy.teardown' && t.idx > w.idx)).length;
      return { warms: warms.length, unpaired };
    };
    let pairing = 'pairing not observable on a deployed target — no stdio capture';
    if (stdio !== undefined) {
      const buildTurn = pairedThrough(0, askedAt);
      assert.ok(buildTurn.warms >= 1,
        `positive control: the build turn must have fired at least one warm marker (parsed ${markers.length} Galaxy markers off stdio)`);
      assert.equal(buildTurn.unpaired, 0, `the build turn fired ${buildTurn.warms} warm(s) and ${buildTurn.unpaired} had no teardown after it`);
      // The TURN-LEVEL teardown, isolated: a build cycle destroys its own box BEFORE it logs
      // its `job report`, so the only teardown that can follow the build turn's last report is
      // the turn's `finally` — deleting that one alone reds here, every run, where the pairing
      // above would stay green on the cycle's own destroy (`testing.md`'s self-heal trap).
      const lastReport = markers.filter((m) => m.ns === 'nebula.Galaxy.build' && m.message === 'job report' && m.at <= askedAt).at(-1);
      assert.ok(lastReport !== undefined, 'positive control: the build turn logged a job report');
      assert.ok(markers.some((m) => m.ns === 'nebula.Galaxy.teardown' && m.idx > lastReport.idx),
        "the turn-level teardown must follow the build turn's last job report — the finally is the only teardown after it");
      const questionTurn = pairedThrough(askedAt, Date.now());
      assert.equal(questionTurn.unpaired, 0, `the question's turn fired ${questionTurn.warms} warm(s) and ${questionTurn.unpaired} had no teardown after it`);
      const leftover = { at: Date.now() + 30_000, names: boxes() };
      while (leftover.names.length > 0 && Date.now() < leftover.at) {
        await new Promise((r) => setTimeout(r, 1_000));
        leftover.names = boxes();
      }
      assert.deepEqual(leftover.names, [],
        `a build-box container outlived its turn: ${leftover.names.join(', ')} — every warm owes a destroy`);
      pairing = `build turn ${buildTurn.warms} warm(s), every one torn down and the turn's own teardown after its last report; ` +
        `question turn ${questionTurn.warms === 0 ? 'did not warm — its pairing was not exercised this run' : `${questionTurn.warms} warm(s), all paired`}; no build box left running`;
    }
    console.error(`  ✓ limb 8 — a plain question was answered through the single path (${pairing})`);

    console.error(`  ── typed a sentence, got a built app (captures: ${capture.dir})`);
  } finally {
    await vite.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
