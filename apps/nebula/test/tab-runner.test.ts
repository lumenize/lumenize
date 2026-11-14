/**
 * How Studio carries a run request to a preview tab (`src/tab-runner.ts`).
 *
 * In-lane because every arm here is a decision over messages and time, pulled out of App.vue so a
 * test can pin it (`calibration.md` §12): which frame is loaded, when the request is posted, what
 * each failure says. The frames are a fake port and the clock is the test's. `persona-tabs` drives
 * the same runner against real frames and real pages.
 */
import { describe, it, expect } from 'vitest';
import { TabRunner, ME_TAB, TAB_RUN_BOUND_MS, NO_SESSION_RETRY_MS, type TabPort } from '../src/tab-runner';

/** A port that records what the runner asked of the frames, and a clock the test advances. */
function harness(opts: { loaded?: string[]; tabs?: string[] } = {}) {
  const loaded = new Set(opts.loaded ?? []);
  const asked: string[] = [];
  const posts: Array<{ tab: string; id: string; code: string }> = [];
  const port: TabPort = {
    isLoaded: (tab) => loaded.has(tab),
    load: (tab) => { loaded.add(tab); asked.push(`load ${tab}`); },
    reload: (tab) => { asked.push(`reload ${tab}`); },
    post: (tab, message) => { posts.push({ tab, id: message.id, code: message.code }); asked.push(`post ${tab}`); },
  };
  let now = 0;
  let nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let n = 0;
  const runner = new TabRunner(port, {
    tabs: () => opts.tabs ?? [ME_TAB, 'gerry'],
    timers: {
      set: (fn, ms) => { timers.set(++nextTimer, { at: now + ms, fn }); return nextTimer; },
      clear: (handle) => { timers.delete(handle as number); },
    },
    newId: () => `r${++n}`,
  });
  /** Move the clock on, firing each timer that comes due, in order. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { runner, asked, posts, advance };
}

/** A promise's outcome once it has one, without waiting for it. */
async function settled<T>(p: Promise<T>): Promise<{ value: T } | { error: string } | 'pending'> {
  const pending = Symbol('pending');
  const first = await Promise.race([p.then((value) => ({ value }), (e: Error) => ({ error: e.message })), Promise.resolve(pending)]);
  return first === pending ? 'pending' : first as { value: T } | { error: string };
}

describe('TabRunner', () => {
  it('loads a tab that has no frame, posts once its page has a client, and answers with the page\'s value', async () => {
    const h = harness();
    const run = h.runner.run('gerry', 'return 1 + 1');
    expect(h.asked).toEqual(['load gerry']);
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts).toEqual([{ tab: 'gerry', id: 'r1', code: 'return 1 + 1' }]);
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 2 });
    expect(await run).toEqual({ ok: true, value: 2 });
  });

  it('posts at once to a tab whose page already said it has a client, and never to another tab', async () => {
    const h = harness({ loaded: [ME_TAB, 'gerry'] });
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    const run = h.runner.run(ME_TAB, 'return client.claims.sub');
    // Mutation: post to every ready tab, and gerry's page runs code meant for the person's own.
    expect(h.asked).toEqual(['post me']);
    h.runner.onMessage(ME_TAB, { type: 'lumenize:ran', id: 'r1', ok: true, value: 'austen' });
    expect(await run).toEqual({ ok: true, value: 'austen' });
  });

  it('answers code that threw as a result, with the error the page gave', async () => {
    const h = harness({ loaded: [ME_TAB] });
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    const run = h.runner.run(ME_TAB, 'throw new Error("no")');
    h.runner.onMessage(ME_TAB, { type: 'lumenize:ran', id: 'r1', ok: false, error: 'Error: no' });
    expect(await run).toEqual({ ok: false, error: 'Error: no' });
  });

  it('refuses a tab the cast does not name, and loads nothing for it', async () => {
    const h = harness();
    await expect(h.runner.run('sally', 'return 1')).rejects.toThrow(
      'There is no tab "sally". The tabs are: me, gerry. A persona gets a tab once docs/personas.md names it under "The cast".');
    expect(h.asked).toEqual([]);
  });

  // A persona's page has no session until its invite's mail has been accepted, a few seconds
  // after it is sent. Mutation: answer the run with the page's no-session answer, and the agent
  // is told Gerry is no member a moment before he is one.
  it('loads a tab again while its page has no session, and runs once it has one', async () => {
    const h = harness();
    const run = h.runner.run('gerry', 'return 1');
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: false, noSession: true, error: 'LoginRequiredError: no member yet' });
    h.runner.onMessage('gerry', { type: 'lumenize:login-required' });
    expect(await settled(run)).toBe('pending');
    expect(h.asked).toEqual(['load gerry', 'post gerry']);
    h.advance(NO_SESSION_RETRY_MS);
    expect(h.asked).toEqual(['load gerry', 'post gerry', 'reload gerry']);
    // The page that comes back is asked again, with the same request.
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts.map((p) => p.id)).toEqual(['r1', 'r1']);
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 1 });
    expect(await run).toEqual({ ok: true, value: 1 });
  });

  it('a later run loads a frame again whose page last had no session', async () => {
    // The first run gave up on Gerry before he was a member, and nothing is left to load his page
    // again. Mutation: drop the reload at a run's start → the second run asks nothing → red.
    const h = harness();
    const first = h.runner.run('gerry', 'return 1');
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: false, noSession: true, error: 'LoginRequiredError: no member yet' });
    h.advance(TAB_RUN_BOUND_MS);
    await expect(first).rejects.toThrow('is not a member of the dev Star yet');
    const asked = h.asked.length;

    const second = h.runner.run('gerry', 'return 2');
    expect(h.asked.slice(asked)).toEqual(['reload gerry']);
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts.at(-1)).toMatchObject({ tab: 'gerry', id: 'r2', code: 'return 2' });
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r2', ok: true, value: 2 });
    expect(await second).toEqual({ ok: true, value: 2 });
  });

  it('a page that had no session and then has a client is a silent page, not a missing member', async () => {
    // Mutation: keep the page's old word once it says it has a client → the failure blames a
    // missing membership and sends the agent to invite a member again → red.
    const h = harness();
    const run = h.runner.run('gerry', 'await forever');
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: false, noSession: true, error: 'LoginRequiredError: no member yet' });
    h.advance(NO_SESSION_RETRY_MS);
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts.map((p) => p.id)).toEqual(['r1', 'r1']);
    h.advance(TAB_RUN_BOUND_MS);
    await expect(run).rejects.toThrow('The tab "gerry" did not answer in 20 s. The code may still be running there.');
  });

  it('fails a posted run at once when its page loads afresh, and leaves it alone on an echo', async () => {
    // A landing or the Reload button can load a page afresh under a run. The request went with
    // the old page, and code that makes a record must not be posted twice. Mutation: treat a
    // fresh load as an echo → the run waits out its bound and says the code may still be running.
    const h = harness();
    const run = h.runner.run(ME_TAB, 'return 1');
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    expect(h.posts).toHaveLength(1);
    // An echo names the reload request it answers: the page stayed, and so did the request.
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded', id: 'reload-7' });
    expect(await settled(run)).toBe('pending');
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    await expect(run).rejects.toThrow('The tab "me" loaded afresh while the code was running, so whether it finished is not known. Look at what it left before running it again.');
    expect(h.posts).toHaveLength(1);
  });

  it('says a persona is not a member yet when its page never gets a session inside the bound', async () => {
    const h = harness();
    const run = h.runner.run('gerry', 'return 1');
    for (let waited = 0; waited < TAB_RUN_BOUND_MS; waited += NO_SESSION_RETRY_MS) {
      h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
      h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: false, noSession: true, error: 'LoginRequiredError: no member yet' });
      h.advance(NO_SESSION_RETRY_MS);
    }
    await expect(run).rejects.toThrow(
      '"gerry" is not a member of the dev Star yet (LoginRequiredError: no member yet). Invite it from the "me" tab at the address `await client.personaAddress(\'gerry\')` gives');
    expect(h.asked.filter((a) => a === 'reload gerry').length).toBeGreaterThan(1);
  });

  it('says so when the person\'s own tab has no session', async () => {
    const h = harness({ loaded: [ME_TAB] });
    const run = h.runner.run(ME_TAB, 'return 1');
    h.runner.onMessage(ME_TAB, { type: 'lumenize:login-required' });
    h.advance(TAB_RUN_BOUND_MS);
    await expect(run).rejects.toThrow('Your own tab had no session on the dev Star for 20 s.');
  });

  // Mutations: drop the bound, and a silent page leaves the agent's turn waiting; say "no client"
  // for a page that has one, and the agent is sent to fix an import that is fine.
  it('fails at its bound, and tells a page with no client from one that is still running', async () => {
    const noClient = harness();
    const first = noClient.runner.run('gerry', 'return 1');
    noClient.advance(TAB_RUN_BOUND_MS - 1);
    expect(await settled(first)).toBe('pending');
    noClient.advance(1);
    await expect(first).rejects.toThrow('The tab "gerry" did not answer in 20 s: its page never said it has a client. Only a page whose app imports ./nebula can be asked to run code.');

    const slow = harness({ loaded: ['gerry'] });
    slow.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    const second = slow.runner.run('gerry', 'await forever');
    slow.advance(TAB_RUN_BOUND_MS);
    await expect(second).rejects.toThrow('The tab "gerry" did not answer in 20 s. The code may still be running there.');
    // A late answer to a run that has ended is dropped.
    slow.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 1 });
  });

  // Mutation: post every waiting run when any tab's page loads, and gerry's code is posted to a
  // page that is not there yet, and lost.
  it('posts a waiting run only when its own tab\'s page has a client', async () => {
    const h = harness({ loaded: [ME_TAB] });
    const run = h.runner.run('gerry', 'return 1');
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    expect(h.posts).toHaveLength(0);
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts).toEqual([{ tab: 'gerry', id: 'r1', code: 'return 1' }]);
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 1 });
    expect(await run).toEqual({ ok: true, value: 1 });
  });

  it('ignores an answer from the wrong tab and an id it never sent, and posts a request once', async () => {
    const h = harness({ loaded: [ME_TAB, 'gerry'] });
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded' });
    const run = h.runner.run(ME_TAB, 'return 1');
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 'from gerry' });
    h.runner.onMessage(ME_TAB, { type: 'lumenize:ran', id: 'zz', ok: true, value: 'unknown id' });
    expect(await settled(run)).toBe('pending');
    // The page saying again that it has a client, as it does when it echoes a reload request,
    // posts nothing a second time. Mutation: drop the posted mark, and the code runs twice.
    h.runner.onMessage(ME_TAB, { type: 'lumenize:loaded', id: 'reload-7' });
    expect(h.posts).toHaveLength(1);
    h.runner.onMessage(ME_TAB, { type: 'lumenize:ran', id: 'r1', ok: true, value: 'mine' });
    expect(await run).toEqual({ ok: true, value: 'mine' });
  });

  it('forgets a removed frame\'s page, so the next run waits for the new page to have a client', async () => {
    const h = harness({ loaded: ['gerry'] });
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    h.runner.forget('gerry');
    const run = h.runner.run('gerry', 'return 1');
    expect(h.posts).toHaveLength(0);
    h.runner.onMessage('gerry', { type: 'lumenize:loaded' });
    expect(h.posts).toHaveLength(1);
    h.runner.onMessage('gerry', { type: 'lumenize:ran', id: 'r1', ok: true, value: 1 });
    expect(await run).toEqual({ ok: true, value: 1 });
  });
});
