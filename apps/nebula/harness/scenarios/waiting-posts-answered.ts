/**
 * Two people post in one chat while a turn runs, and each post is worked on under its own
 * poster's claims.
 *
 * Jennifer owns the app. Austen is a collaborator, enrolled by the real node invite with `write`
 * at the chat node and no admin bit. Jennifer posts, and Austen posts while Jennifer's turn is
 * still running. Each post is stored with the claims its write carried, so when the agent gets to
 * Austen's post it works under Austen's claims, never under those of whoever happened to post
 * first. The agent itself posts every message as `agent:lumenize`.
 *
 * The model is the real one, and what it does with Austen's waiting post is its own choice: it
 * may take the post up, answer it in a message, or write a message that names nothing. So each
 * limb gates only on what holds whichever it picks, and the scenario records the choice without
 * gating on it. `waiting-posts.test.ts` gates the choices themselves, with the model scripted.
 *
 *  1. **Austen's post waits while Jennifer's turn runs.** The Galaxy logs it as waiting, and
 *     starts no second turn beside the first. This is timing, not the model's choice: a turn is
 *     at least one model call long.
 *  2. **Every turn's tools run under the poster of the post it took up, with the agent as
 *     actor.** Each `took up` line's claims name that post's recorded writer. Mutation: log the
 *     turn's ambient claims, and the line names the agent.
 *  3. **Every agent message records the agent as its subject, with no `act`.** Mutation: run the
 *     turns and their posts under the call that started them, and Jennifer is the subject.
 *  4. **A post a turn took up is answered by that turn's message, which names it in `answers`.**
 *     Jennifer's always is. Mutation: build `answers` without the post the turn took up, and
 *     Jennifer's post still waits.
 *  5. **A decision after Jennifer's turn is offered a pick and a message, and no tool that
 *     acts.** Mutation: send it the loop's tools, and its request lists `write_file`. No
 *     decision runs when the turn's closing step already answered Austen's post, which is the
 *     model's choice too, and the limb then says it was not exercised.
 *  6. **Each tool call's record names the post it acted for and that post's poster, with the
 *     agent as actor, and Studio marks each one with that person.** The marks Austen's Studio
 *     renders are compared with the records. Mutation: build a mark from the message's own
 *     record, and Studio names the agent; leave the claims off a call's record, and a call
 *     that ran has none. Every loop tool call that ran is checked, so one with no record
 *     fails. The model is asked to read a file, so there is a call to check; how many it
 *     makes is recorded, and none at all is reported as not exercised.
 *  7. **In Austen's Studio her post ends answered, and never shows as failed.** Austen has
 *     Studio open in a real browser and posts from its composer. Once an agent message names
 *     her post, the status bubble under the thread goes: no *thinking*, no *waiting*, no
 *     failure banner. This holds whether the agent took her post up or answered it in a
 *     message that replies to Jennifer's. Mutation: let Studio decide by `replyTo`, and on the
 *     second path her post shows *thinking* for good. A post the model left unanswered is
 *     recorded, and this limb then gates only on the absence of the failure banner. The
 *     banner is watched for from the page's first load to the end, so one that showed and
 *     went fails the limb. Whether the *waiting* bubble showed is recorded and not gated: it
 *     shows once Jennifer's turn sends a chunk after Austen's post, which is the model's timing.
 */
import assert from 'node:assert/strict';
import { waitForEmail, extractMagicLink } from '@lumenize/email-test/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, NEW_HOST_TIMEOUT_MS } from '../lib/harness';
import { bootStudioVite, launchChromium, instrumentedPage } from '../lib/browser';
import { chatCast } from '../lib/chat-cast';
import { debugLines, waitForDebugLines, type DebugLine } from '../lib/stdio';
import { testSlug } from '../lib/test-scopes';
import { turnCallsOf } from '../lib/turn-calls';

/** Chat and auth only: the requests ask for a file to be read and for words, never for code. */
export const needsContainer = false;

const SCOPE = `${testSlug('waits')}.app`;
/** A real generation fits well inside this; silence past it is the failure. */
const TURN_TIMEOUT_MS = 240_000;
const chatQuery = { typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } };

type Value = { content?: string; replyTo?: string; answers?: string[] };
/** The tools that act, each of which runs under a post's recorded claims and records it. */
const LOOP_TOOLS = ['read_file', 'write_file', 'edit_file', 'build', 'invite'];

export async function run(stack: DevStack): Promise<void> {
  const cast = await chatCast(stack, SCOPE, readDevVar('TEST_TOKEN'));
  const { jennifer } = cast;
  const austenSession = { sub: cast.austenSub };
  const closers: Array<() => Promise<unknown>> = [];
  try {
    // ── Austen opens Studio in a browser, signed in by a real emailed link ──
    const testToken = readDevVar('TEST_TOKEN');
    const vite = await bootStudioVite(stack.baseUrl);
    const chromium = await launchChromium();
    closers.push(() => chromium.close(), () => vite.close());
    const { page } = await instrumentedPage(chromium);
    // What Austen's Studio ever showed, kept across the whole run: a banner that came and went
    // is a failure a read at the end cannot see. The page reports to the harness through an
    // exposed function, which outlives every navigation. The script is a string because tsx
    // wraps a named inner function in a helper the page does not have.
    const saw = { watching: false, failed: false, waiting: false };
    await page.exposeFunction('harnessSaw', (what: keyof typeof saw) => { saw[what] = true; });
    await page.addInitScript(`(() => {
      const report = (what) => { try { window.harnessSaw(what); } catch (e) { /* not installed in this frame */ } };
      const look = () => {
        if (!document.body) return;
        report('watching');
        if (document.body.innerText.includes('No reply arrived')) report('failed');
        if (document.querySelector('[data-testid="turn-waiting"]')) report('waiting');
      };
      const start = () => { new MutationObserver(look).observe(document.documentElement, { childList: true, subtree: true, characterData: true }); look(); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    })()`);
    await page.goto(`${vite.viteBaseUrl}/auth/login`, { waitUntil: 'domcontentloaded' });
    // `_scopeless`: the login request names no scope, so its mail carries no scope tag.
    const waiter = waitForEmail({ testToken, instance: '_scopeless', to: cast.austenEmail, timeout: 120_000 });
    let link: string;
    try {
      await page.getByPlaceholder('you@example.com').fill(cast.austenEmail);
      await page.getByRole('button', { name: /Email me a link/ }).click();
      link = extractMagicLink(await waiter.emailPromise);
    } finally {
      waiter.cleanup();
    }
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('link-continue').click();
    // Continue consumes the link and leaves its page, for Home or straight for her one app.
    await page.waitForURL((u) => !u.pathname.includes('magic-link'), { timeout: NEW_HOST_TIMEOUT_MS });
    if (new URL(page.url()).origin !== vite.scopeUrl(SCOPE)) await page.goto(`${vite.scopeUrl(SCOPE)}/`, { waitUntil: 'domcontentloaded' });
    const composer = page.getByPlaceholder('Describe a change…');
    await composer.waitFor({ state: 'visible', timeout: NEW_HOST_TIMEOUT_MS });

    using thread = jennifer.client.resources.subscribeQuery(chatQuery); await thread.ready;
    const messages = async (): Promise<Array<{ id: string; snap: Snapshot }>> => {
      const out: Array<{ id: string; snap: Snapshot }> = [];
      for (const id of thread.resourceIds) {
        const snap = await jennifer.client.resources.read('Message', id) as Snapshot | null;
        if (snap) out.push({ id, snap });
      }
      return out;
    };
    const here = (line: DebugLine): boolean => line.data.instanceName === SCOPE;
    const turnLines = (all: DebugLine[], message: string): DebugLine[] =>
      all.filter((l) => l.namespace === 'nebula.Galaxy.turn' && l.message === message && here(l));

    // ── The two posts: Austen's lands while Jennifer's turn is running ──
    const j1 = await jennifer.client.postUserMessage('Read AGENTS.md with read_file, then reply with the one word READY and nothing else. Do not change any code.');
    // Austen posts from her Studio's composer, as a person does.
    const austenText = 'When you get to me, reply with the one word SET and nothing else. Do not change any code.';
    await composer.fill(austenText);
    await composer.press('Enter');
    let a1: string | undefined;
    for (const deadline = Date.now() + 30_000; !a1;) {
      a1 = (await messages()).find(({ snap }) => snap.meta.recordedClaims.sub === cast.austenSub)?.id;
      assert.ok(a1 || Date.now() < deadline, "Austen's post never reached the thread");
      if (!a1) await new Promise((r) => setTimeout(r, 250));
    }

    // The loop is idle again once Austen's post is dealt with. If her post arrived before
    // Jennifer's turn read the thread, or that turn's closing step did not answer it, a decision
    // follows the turn: it takes her post up, whose turn then ends in a message replying to it,
    // or it does not. If the closing step answered it, nothing more runs.
    const namesAustens = async (): Promise<boolean> =>
      (await messages()).some(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB && ((snap.value as Value).answers ?? []).includes(a1!));
    let decision: DebugLine | undefined;
    for (const deadline = Date.now() + TURN_TIMEOUT_MS; ;) {
      decision = turnLines(debugLines(stack.logs()), 'decision')[0];
      if (decision || await namesAustens()) break;
      assert.ok(Date.now() < deadline, "neither a decision nor an answer to Austen's post followed Jennifer's turn");
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (decision?.data.postId === a1) {
      const deadline = Date.now() + TURN_TIMEOUT_MS;
      while (!(await messages()).some(({ snap }) => (snap.value as Value).replyTo === a1)) {
        assert.ok(Date.now() < deadline, "the turn that took Austen's post up never posted its message");
        await new Promise((r) => setTimeout(r, 1000));
      }
    } else if (decision) {
      // A decision that picks nothing logs its line before it posts its message, if it has one.
      await new Promise((r) => setTimeout(r, 3000));
    }
    const all = await messages();
    // The capture is read once it holds every line the messages imply. Deployed, a turn's
    // lines arrive when its invocation ends, which can be after its message is in the thread:
    // each turn's message needs its `took up` line, each decision's own message its `decision`
    // line, and each decision request the decision it made.
    const lines = await waitForDebugLines(stack, (capture) => {
      const tookUpPosts = new Set(turnLines(capture, 'took up').map((l) => l.data.postId));
      const logged = (some: DebugLine[]): number => new Set(some.map((l) => l.at)).size;
      const decisions = logged(turnLines(capture, 'decision'));
      const agents = all.filter(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB).map(({ snap }) => snap.value as Value);
      return agents.every((v) => v.replyTo === undefined || tookUpPosts.has(v.replyTo))
        && decisions >= agents.filter((v) => v.replyTo === undefined).length
        // Counted by when each was logged: a deployed capture can hold one line twice, once
        // from the tail and once from Workers Logs.
        && logged(turnLines(capture, 'decision')) >= logged(turnLines(capture, 'request').filter((l) => l.data.step === 'decision'));
    }, 'every turn and decision line the thread implies');
    decision = turnLines(lines, 'decision')[0];
    const tookAustenUp = decision?.data.postId === a1;
    const writerOf = (id: string): string | undefined => all.find((m) => m.id === id)?.snap.meta.recordedClaims.sub;
    const agentMessages = all.filter(({ snap }) => snap.meta.recordedClaims.sub === NEBULA_SUB);
    const answered = new Set(agentMessages.flatMap(({ snap }) => (snap.value as Value).answers ?? []));

    // ── LIMB 1: Austen's post waited ──
    assert.ok(lines.some((l) => l.namespace === 'nebula.Galaxy.trigger' && l.message === 'waiting: a turn is in flight' && l.data.resourceId === a1),
      "Austen's post must be logged as waiting behind Jennifer's turn: the two posts did not overlap");
    console.error("  ✓ limb 1 — Austen's post waited while Jennifer's turn ran");

    // ── LIMB 2: each turn ran under the poster of the post it took up, with the agent as actor ──
    const tookUp = turnLines(lines, 'took up');
    assert.ok(tookUp.length >= 1 && tookUp[0]!.data.postId === j1, "the first turn must take Jennifer's post up");
    assert.equal(writerOf(j1), jennifer.sub);
    assert.equal(writerOf(a1), austenSession.sub);
    for (const line of tookUp) {
      const claims = line.data.claims as { sub?: string; act?: { sub?: string } } | null;
      assert.equal(claims?.sub, writerOf(line.data.postId), `the turn on ${line.data.postId} must run under its poster's claims, and ran under ${JSON.stringify(claims)}`);
      assert.equal(claims?.act?.sub, NEBULA_SUB, 'the agent must be the actor on those claims');
    }
    console.error(`  ✓ limb 2 — ${tookUp.length} turn(s), each under the poster of the post it took up, with the agent as actor`);

    // ── LIMB 3: the agent posts as itself ──
    assert.ok(agentMessages.length >= 1, 'the agent must have posted');
    for (const { id, snap } of all) {
      if (id === j1 || id === a1) continue;
      assert.equal(snap.meta.recordedClaims.sub, NEBULA_SUB, `message ${id} must be the agent's own`);
      assert.equal(snap.meta.recordedClaims.act, undefined, 'nobody acts for the agent on its own post');
    }
    console.error(`  ✓ limb 3 — ${agentMessages.length} agent message(s), each recorded as the agent with no act`);

    // ── LIMB 4: a post a turn took up is answered by a message naming it ──
    for (const line of tookUp) {
      const reply = agentMessages.find(({ snap }) => (snap.value as Value).replyTo === line.data.postId);
      assert.ok(reply, `the turn on ${line.data.postId} must end in a message replying to it`);
      assert.ok((reply.snap.value as Value).answers?.includes(line.data.postId), 'that message must name the post in answers');
    }
    assert.ok(answered.has(j1), "Jennifer's post must be answered");
    console.error('  ✓ limb 4 — each post a turn took up is answered by that turn\'s message');

    // ── LIMB 5: the decision is offered a pick and a message, and nothing that acts ──
    const decisionRequests = turnLines(lines, 'request').filter((l) => l.data.step === 'decision');
    assert.equal(decisionRequests.length >= 1, decision !== undefined, 'a decision makes a model request, and nothing else does in its name');
    for (const request of decisionRequests) assert.deepEqual(request.data.tools, ['take_up', 'mark_complete']);
    console.error(decision
      ? '  ✓ limb 5 — the decision was offered take_up and mark_complete only'
      : "  ✓ limb 5 — no decision ran: the closing step of Jennifer's turn answered Austen's post (not exercised)");

    // ── LIMB 6: each tool call's record, and Studio's mark for it ──
    // Every loop tool call that ran, whether or not it recorded anything: one with no record
    // is the failure, so the list cannot be built from the records.
    const recorded = (await Promise.all(agentMessages.map(({ id }) => turnCallsOf(jennifer.client, id)))).flat()
      .filter((call) => LOOP_TOOLS.includes(call.name) && call.error === undefined)
      .map((call) => call as typeof call & { claims?: { sub?: string; act?: { sub?: string } } });
    for (const call of recorded) {
      assert.ok(call.post && call.claims, `a ${call.name} that ran must record the post it acted for and the claims it ran under, and recorded ${JSON.stringify({ post: call.post, claims: call.claims })}`);
      assert.equal(call.claims!.sub, writerOf(call.post!), `a ${call.name} for post ${call.post} must record its poster's claims`);
      assert.equal(call.claims!.act?.sub, NEBULA_SUB, 'with the agent as actor');
      assert.deepEqual(Object.keys(call.claims!).filter((k) => k === 'access' || k === 'aud'), [], 'and nothing a client must not be sent');
    }
    const marksLocator = page.getByTestId('tool-call-mark');
    if (recorded.length > 0) await marksLocator.first().waitFor({ state: 'attached', timeout: 30_000 });
    const marks = await marksLocator.evaluateAll((els) => els.map((el) => ({ post: el.getAttribute('data-post'), sub: el.getAttribute('data-sub') })));
    assert.equal(marks.length, recorded.length, `Studio must mark each of the ${recorded.length} recorded tool call(s), and marked ${marks.length}`);
    for (const mark of marks) assert.equal(mark.sub, writerOf(mark.post!), `the mark on a call for post ${mark.post} must name its poster`);
    console.error(recorded.length > 0
      ? `  ✓ limb 6 — ${recorded.length} tool call(s) recorded under their post's poster, and Studio marked each with that person`
      : '  ✓ limb 6 — the model called no tool that acts, so no record was checked (not exercised)');

    // ── LIMB 7: in Austen's Studio her post ends answered, and never shows as failed ──
    assert.equal(saw.watching, true, "the watch on Austen's Studio never ran, so it cannot say what the page showed");
    assert.equal(saw.failed, false, "Austen's Studio must never show her post as failed, at any moment of the run");
    assert.equal(await page.getByText('No reply arrived').count(), 0, "Austen's post must not show as failed");
    // Whether the waiting bubble showed turns on when Jennifer's turn sent a chunk, which is the
    // model's timing, so it is recorded and not gated.
    console.error(`  · recorded — Austen's Studio ${saw.waiting ? 'showed' : 'never showed'} her post as waiting behind Jennifer's turn`);
    if (answered.has(a1)) {
      const settled = async (): Promise<boolean> =>
        await page.getByTestId('turn-thinking').count() === 0 && await page.getByTestId('turn-waiting').count() === 0;
      for (const deadline = Date.now() + 30_000; !(await settled());) {
        assert.ok(Date.now() < deadline, "Austen's Studio still shows her post as thinking or waiting, though an agent message answers it");
        await new Promise((r) => setTimeout(r, 500));
      }
      assert.equal(await page.getByText('No reply arrived').count(), 0);
      console.error("  ✓ limb 7 — Austen's Studio shows her post answered: no thinking, no waiting, no failure banner");
    } else {
      console.error("  ✓ limb 7 — Austen's post was left unanswered by the model, and her Studio shows no failure banner (the answered half not exercised)");
    }

    // ── Recorded, never gated: what the real model did with Austen's waiting post ──
    const how = tookAustenUp ? 'the decision took her post up, and its turn answered it'
      : !decision ? "the closing step of Jennifer's turn answered it"
      : answered.has(a1) ? 'the decision answered it in a message that named it'
      : 'the decision named no post, so it still waits for the next post\'s turn';
    console.error(`  · recorded — Austen's waiting post: ${how}`);
  } finally {
    for (const close of closers) await close().catch(() => { /* already closed */ });
    cast.dispose();
  }
}
