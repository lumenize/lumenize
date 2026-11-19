/**
 * **A deploy that cuts a turn short leaves it to continue, with no one acting.**
 *
 * The real-eviction scene for a turn stored round by round. Jennifer founds an app with Studio
 * open, a socket on the Galaxy, and asks for a change long enough to span a deploy. Once the turn's
 * first `Round` is stored, the test Worker is deployed again with an immediate code update, which
 * restarts the Galaxy at once and drops its sockets. A Studio's reconnect, Jennifer's or Austen's,
 * constructs the Galaxy again, and its `onStart` wakes the turn. The scenario then only watches:
 * its subscriptions were opened before the deploy, and it makes no call to the Galaxy until the
 * turn's `Message` arrives or a bound passes.
 *
 * It gates on what holds whatever the model writes:
 *
 *  1. **The turn ends in its `Message`**, replying to the post, with no call from the scenario.
 *     If the bound passes, one call is made, and if the `Message` follows it, that is reported
 *     and the scenario fails: a deploy then cuts a turn that no construction wakes.
 *  2. **The Galaxy started again between the first round and the `Message`.** The Worker's logs hold a
 *     Galaxy start for this app logged after the first round's write and before the `Message`'s
 *     commit. Without one the deploy came too late to cut the turn, and the run is inconclusive,
 *     which fails as such.
 *
 * It reports what the eviction cost: each Studio's connection states, the model calls the wake
 * recorded as cut, and the calls the rounds answered as interrupted.
 *
 * Deployed only, and only when asked, like `redeploy-strands-no-client`: a local stack has no
 * deploy, and a deploy in the middle of a sweep would restart every other scenario's objects. Run
 * it with `HARNESS_REDEPLOY=1` against the test target alone, after the deploy that put the build
 * there, so this deploy pushes no new image and lands while the turn still runs. It refuses any
 * target but `lumenize-test.dev`, since the command it runs deploys that.
 *
 * `needsContainer = true` — the turn builds.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Snapshot } from '@lumenize/resources';
import { DEFAULT_CHAT_ID, roundsOf } from '@lumenize/nebula/client';
import { NEBULA_SUB } from '@lumenize/mesh/client';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';
import { chatCast } from '../lib/chat-cast';
import { testSlug } from '../lib/test-scopes';
import { debugLines, loggedAfter, waitForDebugLines, LOG_WAIT_MS, type DebugLine } from '../lib/stdio';
import { INTERRUPTED_CALL_ERROR, type StoredRound } from '../../src/codegen-loop';

export const needsContainer = true;

/** Parked in every sweep: its deploy would restart the objects other scenarios are using. */
export const skip = 'run it directly, deployed, with HARNESS_REDEPLOY=1: it redeploys the test Worker';

/** Long enough for a woken turn to finish its remaining rounds and build. */
const MESSAGE_BOUND_MS = 10 * 60_000;
/** Long enough for a real turn to store its first round. */
const FIRST_ROUND_MS = 4 * 60_000;
const REQUEST = 'Make these changes one at a time, and build after each one: add a heading that says "Deals", '
  + 'then a short paragraph under it saying what the app is for, then a footer with the year. Report when done.';

/** Poll `check` until it holds or `ms` passes; answers whether it held. */
async function eventually(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

export async function run(stack: DevStack): Promise<void> {
  const target = process.env.HARNESS_TARGET_URL;
  if (!target || process.env.HARNESS_REDEPLOY !== '1') {
    console.log('  · skipped: deployed only, with HARNESS_REDEPLOY=1, since it redeploys the test Worker');
    return;
  }
  assert.ok(new URL(target).hostname.endsWith('lumenize-test.dev'),
    `this scenario redeploys the test Worker, and ${target} is not the test target`);

  const scope = `${testSlug('cut')}.app`;
  const cast = await chatCast(stack, scope, readDevVar('TEST_TOKEN'));
  const studio = cast.jennifer.client;
  // Both Studios hold a socket on the Galaxy, and either may be the first Client into the restarted Galaxy.
  const tabs = { jennifer: studio, austen: cast.austen.client };
  const states: Record<string, string[]> = { jennifer: [studio.connectionState], austen: [cast.austen.client.connectionState] };
  const watch = setInterval(() => {
    for (const [name, client] of Object.entries(tabs)) if (states[name]!.at(-1) !== client.connectionState) states[name]!.push(client.connectionState);
  }, 20);
  let disposed = false;
  try {
    // Every subscription is opened before the deploy, so nothing after it calls the Galaxy. Each
    // goes with its client, which the limbs below dispose.
    const thread = studio.resources.subscribeQuery({ typeName: 'Message', filter: { chat: DEFAULT_CHAT_ID } });
    await thread.ready;
    const firstChunk = new Promise<string>((resolve) => { studio.setOnStreamChunk((id) => { resolve(id); }); });
    const posted = await studio.postUserMessage(REQUEST);
    const message = await Promise.race([firstChunk, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no progress chunk arrived for the turn')), FIRST_ROUND_MS))]);
    const rounds = studio.resources.subscribeQuery(roundsOf(message));
    await rounds.ready;
    assert.ok(await eventually(() => rounds.resourceIds.length > 0, FIRST_ROUND_MS), 'the turn stored no round');
    assert.ok(!thread.resourceIds.includes(message), 'the turn ended before the deploy began, so it cannot be cut');

    console.log('  · the turn has stored its first round; redeploying the test Worker with an immediate code update…');
    const appDir = fileURLToPath(new URL('../..', import.meta.url));
    const deployed = await new Promise<number | null>((resolve) => {
      const child = spawn('npm', ['run', 'deploy:test', '--', '--durable-objects-code-update-mode', 'immediate'], { cwd: appDir, stdio: 'inherit' });
      const bound = setTimeout(() => { child.kill('SIGINT'); }, 15 * 60_000);
      child.on('close', (code) => { clearTimeout(bound); resolve(code); });
    });
    assert.equal(deployed, 0, `npm run deploy:test exited ${deployed}`);

    // ── LIMB 1: the Message arrives with no call from here ──
    let continuedByUs = false;
    if (!await eventually(() => thread.resourceIds.includes(message), MESSAGE_BOUND_MS)) {
      console.log('  · no Message within the bound; posting once, to see whether a call continues the turn');
      await studio.postUserMessage('Are you still working on that?');
      continuedByUs = await eventually(() => thread.resourceIds.includes(message), MESSAGE_BOUND_MS);
    }
    console.log(`  · the Studios' sockets went ${JSON.stringify(states)}`);
    assert.ok(!continuedByUs, 'the turn continued only after a call from the scenario: a deploy cut it and no construction woke it');
    assert.ok(thread.resourceIds.includes(message), `the turn's Message ${message} never arrived`);
    const committed = await studio.resources.read('Message', message) as Snapshot;
    assert.equal(committed.meta.recordedClaims.sub, NEBULA_SUB);
    assert.equal((committed.value as { replyTo?: string }).replyTo, posted, 'the Message must reply to the post its turn took up');
    console.log(`  ✓ limb 1 — the turn ended in its Message (stop ${(committed.value as { codegen?: { stop?: string } }).codegen?.stop}) with no call from the scenario`);

    // What the eviction cost, read while the clients are still connected.
    const { snapshots } = await studio.resources.query(roundsOf(message));
    const interrupted = snapshots.flatMap((s) => (s.value as StoredRound).calls.filter((c) => c.error === INTERRUPTED_CALL_ERROR)
      .map(() => (s.value as StoredRound).index));

    // ── LIMB 2: the Galaxy started again between the first round and the Message ──
    // The restarted Galaxy's start, its wake and the woken turn's commit are all logged in the
    // reconnecting Studio's upgrade, whose lines arrive deployed only when its socket closes
    // (`live-scenarios.md` § *Reading the Worker's logs*), so every socket closes first. A line
    // can also come later through Workers Logs, so the limb waits for every line it reads.
    cast.dispose();
    disposed = true;
    const firstRoundOf = (all: DebugLine[]) => all.filter((l) => l.namespace === 'nebula.Galaxy.rounds' && l.data.message === message)
      .sort((a, b) => (loggedAfter(a, b) ? 1 : -1))[0];
    const commitOf = (all: DebugLine[]) => all.find((l) => l.namespace === 'nebula.Galaxy.stream' && l.message === 'commit' && l.data.messageId === message);
    const restartsOf = (all: DebugLine[]) => {
      const first = firstRoundOf(all);
      const commit = commitOf(all);
      return first && commit
        ? all.filter((l) => l.namespace === 'nebula.Galaxy.onStart' && l.data.name === scope && loggedAfter(l, first) && loggedAfter(commit, l))
        : [];
    };
    const lines = await waitForDebugLines(stack, (all) => restartsOf(all).length > 0, 'a Galaxy start between the first round and the Message', LOG_WAIT_MS)
      .catch(() => debugLines(stack.logs()));
    const firstRound = firstRoundOf(lines);
    const commit = commitOf(lines);
    assert.ok(firstRound && commit, 'the Worker\'s logs must hold the first round\'s write and the Message\'s commit');
    const between = (l: DebugLine) => loggedAfter(l, firstRound) && loggedAfter(commit, l);
    const restarts = restartsOf(lines);
    const wakes = lines.filter((l) => l.namespace === 'nebula.Galaxy.wake' && l.message === 'woke' && l.data.instanceName === scope && between(l));
    assert.ok(restarts.length > 0, 'INCONCLUSIVE: no Galaxy start was logged between the first round and the Message, so the deploy did not cut the turn');
    // Counted by when each was logged: deployed, the tail and Workers Logs can both deliver one line.
    const distinct = (ls: DebugLine[]): number => new Set(ls.map((l) => l.at)).size;
    console.log(`  ✓ limb 2 — ${distinct(restarts)} Galaxy start(s) and ${distinct(wakes)} wake(s) between the first round and the Message`);

    // What the eviction cost, reported and never gated.
    const cut = lines.filter((l) => l.namespace === 'nebula.Galaxy.rounds' && l.message === 'cut model call recorded' && l.data.message === message);
    console.log(`  · model calls recorded as cut: ${JSON.stringify(cut.map((l) => l.data.index))}; calls answered as interrupted, by round: ${JSON.stringify(interrupted)}`);
  } finally {
    clearInterval(watch);
    if (!disposed) cast.dispose();
  }
}
