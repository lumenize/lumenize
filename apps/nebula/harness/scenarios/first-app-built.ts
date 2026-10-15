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
 *  5. **The preview serves the BUILT app, on the dev Star's own host.** Asserted on the
 *     server-injected scope meta rather than on "the iframe has a body" — a 404 and the SPA shell
 *     both have bodies, and only a dist served out of the Galaxy's own VFS carries that tag. And
 *     the Reload control navigates the frame, read as the frame's own document going away, the
 *     positive control for limb 6.
 *  6. **A reloaded Studio renders the built app, and leaves a current frame where it is.** The
 *     frame's scope meta proves the dist served cold. When the app has a client, Studio's request
 *     on the first `ServedBuild` value names the build the frame already runs, so the frame stays.
 *     *Reds if a cold load stops serving, or if Studio moves a frame that is current.*
 *  7. **A fresh Galaxy carries its own guidance layer.** The seeded `AGENTS.md` and the one-line
 *     `CLAUDE.md`, read through the chat-floor `readSource` entry BEFORE the model's first turn.
 *     *Reds if the seed leaves the scaffold, or the entry stops answering a chat-`write` caller.*
 *  8. **A plain question is answered through the single path, and every warm is torn down.**
 *     Asserted on the Worker's own `warm`/`teardown` markers off stdio, paired per turn, with the
 *     turn-level teardown isolated after the build turn's last job report, in both venues;
 *     `docker ps` is the outside witness on a local stack. *Reds if a teardown stops running, or
 *     the reply never lands.*
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
import { uniqueTestEmail, waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import type { Galaxy } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID, deriveKind } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, connectDriver, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { LOG_WAIT_MS, loggedAfter } from '../lib/stdio';
import { launchChromium, bootStudioVite, instrumentedPage, captureArtifacts } from '../lib/browser';
import { provisionAndLogin, requestMagicLink } from '../../test/lib/email-login';

/** The build box is the subject — this one genuinely needs Docker. */
export const needsContainer = true;
/** The Worker's warm, teardown, build, write and stream markers, for limb 8 and the EXPLORATORY
 *  limb (g) below — read back off the dev stack's stdio; only these namespaces, so the boot is not
 *  flooded. `nebula.Galaxy.model` writes only when Workers AI refuses a call, and then the whole
 *  body: two sweeps' build turns ended on a 400 whose cause the reply cuts short (2026-10-12). */
export const bootVars = { DEBUG: 'nebula.Galaxy.warm,nebula.Galaxy.teardown,nebula.Galaxy.build,nebula.Galaxy.writeSource,nebula.Galaxy.stream,nebula.Resources.stream,nebula.Galaxy.model' };

/** The Galaxy's own markers, parsed leniently off the dev stack's stdio — the log objects are
 *  pretty-printed JSON, one per `console.debug`; anything that is not one of ours is skipped. */
type GalaxyMarker = { ns: string; message: string; at: number; idx: number; instanceName?: string };
/** Every `nebula.Galaxy.*` marker off the Worker's captured lines. Ordered with `loggedAfter`: by
 *  time, then by position for two markers logged in one millisecond, which a timestamp cannot say. */
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

/** The latest durable agent reply and its manifest — what the model's turn actually did — for
 *  attributing a red: a stop with no successful build is the model's; a refreshed preview
 *  beside a 404 is a dist that never arrived (`tasks/backlog.md`'s `build-box` row). A build
 *  the turn ended on that was held back landed nothing, which `heldBack` says. */
async function latestAgentTurn(stack: DevStack, galaxy: string, session: { accessToken: string; sub: string }): Promise<{ manifest: string; reply: string; heldBack: boolean }> {
  const driver = await connectDriver(stack, { scope: galaxy, session });
  try {
    using sub = driver.client.resources.subscribeQuery(chatQuery); await sub.ready;
    const replies: Array<{ at: string; v: Record<string, unknown> }> = [];
    for (const rid of sub.resourceIds) {
      const snap = await driver.client.resources.read('Message', rid) as Snapshot | null;
      if (snap && deriveKind(snap.meta.actingToken) === 'agent') replies.push({ at: String((snap.meta as { validFrom?: string }).validFrom ?? ''), v: snap.value as Record<string, unknown> });
    }
    const last = replies.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (!last) return { manifest: 'no agent reply found', reply: '', heldBack: false };
    const cg = last.v.codegen as { stop?: string; rounds?: number; appliedPaths?: string[]; toolCalls?: Array<{ name: string; result?: unknown; error?: string }> } | undefined;
    const builds = (cg?.toolCalls ?? []).filter((t) => t.name === 'build');
    const lastBuild = builds.at(-1);
    const r = lastBuild?.result as { preview?: { refreshed?: boolean; why?: string }; typeCheck?: { findings?: unknown[] } } | undefined;
    const reply = String(last.v.content ?? '');
    const manifest = `stop=${cg?.stop} rounds=${cg?.rounds} applied=${(cg?.appliedPaths ?? []).join(',') || '-'} builds=${builds.length}` +
      ` reply=${JSON.stringify(reply.slice(0, 200))}` +
      (lastBuild ? (lastBuild.error ? ` lastBuild=error: ${lastBuild.error}` : ` lastBuild.preview=${JSON.stringify(r?.preview ?? null)} findings=${JSON.stringify(r?.typeCheck?.findings ?? null).slice(0, 1200)}`) : '');
    return { manifest, reply, heldBack: !!lastBuild && !lastBuild.error && r?.preview?.refreshed === false };
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
  const universe = testSlug('built');
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

    // ── LIMB 1: a letter of the browser's own → Home → Universe page → click into the app ──────
    // Provisioning spent its link, which signs in once, so the browser signs in with its own.
    const waiter = waitForEmail({ testToken, to: person, timeout: 120_000 });
    let link: string;
    try {
      await requestMagicLink({ baseUrl: vite.viteBaseUrl, email: person });
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    assert.ok(link.startsWith(vite.viteBaseUrl),
      `the emailed link must name the browsing origin as sent (got ${new URL(link).origin})`);
    // Continue lands on Home. The membership was accepted during provisioning and its account holds
    // one app, so Home has nothing to choose and fast-forwards into that app's Studio — waited on
    // below, which is an auto-waiting assertion rather than a delay.
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('link-continue').click();
    // ⚠️ Nothing to dismiss on the way in. The nickname is taken at the consent modal, so no
    // completion gate stands between arriving and working — this identity accepted programmatically
    // (`provisionAndLogin`), so it simply has none and its byline falls back to "Someone".
    // `signup-to-first-app` limb 7 is where the consent nickname's journey to a byline is asserted.
    await page.waitForURL((u) => u.origin === vite.scopeUrl(galaxy), { timeout: NEW_HOST_TIMEOUT_MS });

    const composer = page.getByPlaceholder(COMPOSER);
    try {
      await composer.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (e) {
      await captureArtifacts(inst, 'first-app-built-connect-failed');
      throw e;
    }
    const refusals = inst.failedRequests.filter(
      (r) => r.url.endsWith('/auth/refresh-token') && (r.status === 401 || r.status === 'failed'),
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
    // ⚠️ The THOUGHT DISCLOSURE, not a "Lumenize" byline: the transient streaming bubble also carries
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
          throw new Error('the failure banner PAINTED before any reply — either the idle window elapsed on a ' +
            'turn that was still running, which the server heartbeat exists to prevent, or the turn died and ' +
            'the banner is right; the Galaxy\'s logs say which ' +
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
      // Raced against the watch, so a banner, a frozen spinner or an empty bubble ends the run when it
      // appears. Awaited one after the other, a turn that died waited out the whole deadline with its
      // banner already up (2026-10-07, a deployed Galaxy reset mid-turn: 1064 s). The deadline stays
      // for a turn that keeps beating and never answers, since a live turn may run 14 minutes.
      await Promise.race([
        page.getByText('💭 thought process').first().waitFor({ state: 'visible', timeout: TURN_TIMEOUT_MS }),
        liveWatch,
      ]);
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
    const agentChat = page.locator('div.chat', { has: page.locator('[data-testid="byline"]', { hasText: /^Lumenize/ }) }).first();
    await agentChat.waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await agentChat.locator('[data-testid="party-avatar"]').count(), 2,
      'an act-bearing message must stack two faces: the actor and the subject');
    assert.equal(await agentChat.locator('[data-testid="party-avatar"].z-10').getAttribute('data-name'), 'Lumenize',
      'the ACTOR (the agent) must be the face in front');
    console.error('  ✓ limb 4 — no failure banner survived the turn; the agent\'s reply stacks actor over subject');

    // ── LIMB 5: the preview serves the BUILT app ──────────────────────────────────────────────
    /** The preview frame's document, evaluated across origins; `undefined` between documents. */
    const inPreview = async <T>(fn: () => T): Promise<T | undefined> => {
      const frame = await (await page.locator('iframe[title="Preview"]').elementHandle())?.contentFrame();
      return frame ? frame.evaluate(fn).catch(() => undefined) : undefined;
    };
    /** A mark on the frame's window, which a navigation of the frame clears. */
    const markFrame = async () => (await inPreview(() => { (window as unknown as { __mark?: boolean }).__mark = true; return true; })) === true;
    const frameMarked = async () => (await inPreview(() => (window as unknown as { __mark?: boolean }).__mark === true)) === true;
    const until = async (ms: number, check: () => Promise<boolean>): Promise<boolean> => {
      for (const deadline = Date.now() + ms; ;) {
        if (await check()) return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    // The build turn's manifest, printed on every run: on a red it says whether a build ever
    // succeeded (a stop with no refreshed preview is the model's) or the dist never arrived
    // (refreshed, then a 404); on a green it is the record of what the turn did. Read first,
    // because a turn may end on a build held back for its type findings, which lands nothing:
    // then its reply must say so, and the build is previewed by hand before `.dev` is read.
    const owner = { accessToken: provisioned.accessToken, sub: provisioned.sub };
    const turn = await latestAgentTurn(stack, galaxy, owner)
      .catch((e: unknown) => ({ manifest: `manifest unavailable: ${e instanceof Error ? e.message : String(e)}`, reply: '', heldBack: false }));
    const manifest = turn.manifest;
    console.error(`  · the build turn's reply: ${manifest}`);
    if (turn.heldBack) {
      assert.match(turn.reply, /The preview was not updated: /,
        `a turn that ended on a held-back build must say so in its reply: ${manifest}`);
      const driver = await connectDriver(stack, { scope: galaxy, session: owner });
      try {
        const previewed = await driver.client.lmz.callAsync('GALAXY', galaxy,
          driver.client.ctn<Galaxy>().buildNow({ preview: true }), { timeoutMs: 240_000 }) as { preview: { refreshed: boolean; why: string } };
        assert.ok(previewed.preview.refreshed, `previewing the held-back build landed nothing: ${previewed.preview.why}`);
      } finally {
        driver.dispose();
      }
      console.error('  · the turn ended on a held-back build, said so, and was previewed with { "preview": true }');
    }
    const previewUrl = `${vite.scopeUrl(`${galaxy}.dev`)}/`;
    const expectedBase = '<meta name="nebula-scope"';
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
    if (!(served && served.body.includes(expectedBase))) {
      assert.fail(`the preview did not serve a built app from the Galaxy's VFS — expected the injected ` +
        `${expectedBase} at ${previewUrl}, got status ${served?.status} (${served?.body.length ?? 0} bytes). ` +
        `The turn completed; its reply says ${manifest}`);
    }
    // The iframe is what the person actually looks at — assert it is pointed at the same place.
    const src = await page.locator('iframe[title="Preview"]').getAttribute('src');
    assert.ok(src?.startsWith(previewUrl),
      `the preview iframe must point at the app's dev Star, got ${src}`);
    // POSITIVE CONTROL for limb 6: the Reload control navigates the frame, seen as a mark left on
    // the frame's window going away. Driven by the button rather than a landing, which depends on
    // the model's findings rather than on the code under test.
    const reloadButton = page.getByTitle('Reload preview');
    await reloadButton.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForFunction(() => !(document.querySelector('button[title="Reload preview"]') as HTMLButtonElement | null)?.disabled,
      undefined, { timeout: 60_000, polling: 250 });
    assert.ok(await markFrame(), 'the preview frame could not be marked before Reload');
    await reloadButton.click();
    assert.ok(await until(30_000, async () => !(await frameMarked())), 'the Reload control never navigated the preview frame');
    console.error(`  ✓ limb 5 — the preview serves the built app (${served.body.length} bytes); Reload navigates the frame`);

    // ── LIMB 6: a reloaded Studio renders the built app, and leaves a current frame put ──────────
    // `dist/` serves from the Galaxy's VFS, so a reload's frame carries the built app on its own,
    // asserted on the server-injected scope meta, which only a served dist carries. Studio then
    // asks the frame about the first `ServedBuild` value, which names the build the frame runs:
    // a frame with a client stays. A frame with none (an app whose `App.vue` never imports
    // `./nebula`) cannot answer, so Studio sets its address once, and the stay is not asserted.
    // Studio's window counts the `loaded` posts its frame sends, which only a frame with a client does.
    await page.addInitScript(() => {
      if (window.top !== window) return;
      window.addEventListener('message', (e) => {
        if ((e.data as { type?: string } | null)?.type !== 'lumenize:loaded') return;
        const w = window as unknown as { __loadedFromFrame?: number };
        w.__loadedFromFrame = (w.__loadedFromFrame ?? 0) + 1;
      });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await composer.waitFor({ state: 'visible', timeout: 30_000 });
    const frameMeta = page.frameLocator('iframe[title="Preview"]').locator('meta[name="nebula-scope"]').first();
    await frameMeta.waitFor({ state: 'attached', timeout: 30_000 });
    assert.match(await frameMeta.getAttribute('content') ?? '', /"dev":true/,
      'the reloaded preview frame must render the built app (the injected scope meta)');
    await new Promise((r) => setTimeout(r, 1_000)); // the frame's first `loaded` is posted as it loads
    const answered = await page.evaluate(() => (window as unknown as { __loadedFromFrame?: number }).__loadedFromFrame ?? 0);
    if (answered > 0) {
      await markFrame();
      await new Promise((r) => setTimeout(r, 12_000)); // past Studio's 10 s wait for an echo
      assert.ok(await frameMarked(), 'Studio moved a preview frame that runs the current build');
      console.error('  ✓ limb 6 — a reloaded Studio renders the built app and left the current frame where it was');
    } else {
      console.error('  ✓ limb 6 — a reloaded Studio renders the built app (the app has no client, so its stay is not asserted)');
    }

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
    // This Galaxy's markers only, on the stamp every marker carries (`testing.md`).
    const markersIn = (raw: string) => galaxyMarkers(raw).filter((m) => m.instanceName === galaxy);
    // A warm is the FIRED marker, not the namespace: a failed start warns there without `by`.
    const warmsOf = (ms: GalaxyMarker[]) => ms.filter((m) => m.ns === 'nebula.Galaxy.warm' && m.message === 'container warm fired');
    const pairedIn = (ms: GalaxyMarker[], from: number, to: number): { warms: number; unpaired: number } => {
      const inWindow = ms.filter((m) => m.at >= from && m.at <= to);
      const warms = warmsOf(inWindow);
      const unpaired = warms.filter((w) => !inWindow.some((t) => t.ns === 'nebula.Galaxy.teardown' && loggedAfter(t, w))).length;
      return { warms: warms.length, unpaired };
    };
    // The turn's teardown is logged by its own invocation, which a deployed capture delivers when
    // that ends, so the read waits until every warm has its teardown, or the venue's budget runs out
    // and the assertions below say what is missing (`live-scenarios.md` § *Reading the Worker's logs*).
    const lastReportIn = (ms: GalaxyMarker[]) =>
      ms.filter((m) => m.ns === 'nebula.Galaxy.build' && m.message === 'job report' && m.at <= askedAt).at(-1);
    for (const deadline = Date.now() + LOG_WAIT_MS; Date.now() < deadline; await new Promise((r) => setTimeout(r, 1_000))) {
      const ms = markersIn(stack.logs());
      const report = lastReportIn(ms);
      if (warmsOf(ms).length > 0 && pairedIn(ms, 0, askedAt).unpaired === 0 && pairedIn(ms, askedAt, Date.now()).unpaired === 0
        && report !== undefined && ms.some((m) => m.ns === 'nebula.Galaxy.teardown' && loggedAfter(m, report))) break;
    }
    const markers = markersIn(stack.logs());
    const pairedThrough = (from: number, to: number) => pairedIn(markers, from, to);
    const buildTurn = pairedThrough(0, askedAt);
    assert.ok(buildTurn.warms >= 1,
      `positive control: the build turn must have fired at least one warm marker (parsed ${markers.length} Galaxy markers off stdio)`);
    assert.equal(buildTurn.unpaired, 0, `the build turn fired ${buildTurn.warms} warm(s) and ${buildTurn.unpaired} had no teardown after it`);
    // The TURN-LEVEL teardown, isolated: a build cycle destroys its own box BEFORE it logs
    // its `job report`, so the only teardown that can follow the build turn's last report is
    // the turn's `finally` — deleting that one alone reds here, every run, where the pairing
    // above would stay green on the cycle's own destroy (`testing.md`'s self-heal trap).
    const lastReport = lastReportIn(markers);
    assert.ok(lastReport !== undefined, 'positive control: the build turn logged a job report');
    assert.ok(markers.some((m) => m.ns === 'nebula.Galaxy.teardown' && loggedAfter(m, lastReport)),
      "the turn-level teardown must follow the build turn's last job report — the finally is the only teardown after it");
    const questionTurn = pairedThrough(askedAt, Date.now());
    assert.equal(questionTurn.unpaired, 0, `the question's turn fired ${questionTurn.warms} warm(s) and ${questionTurn.unpaired} had no teardown after it`);
    let pairing = `build turn ${buildTurn.warms} warm(s), every one torn down and the turn's own teardown after its last report; ` +
      `question turn ${questionTurn.warms === 0 ? 'did not warm — its pairing was not exercised this run' : `${questionTurn.warms} warm(s), all paired`}`;
    // `docker ps` sees only a local stack's containers.
    if (process.env.HARNESS_TARGET_URL === undefined) {
      const leftover = { at: Date.now() + 30_000, names: boxes() };
      while (leftover.names.length > 0 && Date.now() < leftover.at) {
        await new Promise((r) => setTimeout(r, 1_000));
        leftover.names = boxes();
      }
      assert.deepEqual(leftover.names, [],
        `a build-box container outlived its turn: ${leftover.names.join(', ')} — every warm owes a destroy`);
      pairing += '; no build box left running';
    }
    console.error(`  ✓ limb 8 — a plain question was answered through the single path (${pairing})`);

    console.error(`  ── typed a sentence, got a built app (captures: ${capture.dir})`);
  } finally {
    await vite.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
