/**
 * A dev Star's page, framed in Studio, runs code Studio hands it (jsdom `frontend` project).
 *
 * In-lane for the reason `reload-request.test.ts` gives: what this listener refuses cannot be
 * produced by a running system. `frame-ancestors` lets only the galaxy's Studio frame a dev Star's
 * page, so only jsdom can post from a parent at another origin, or from a window that is not the
 * parent; and a tenant Star's page is never framed at all. What a running system does show, Studio
 * asking a real page and a persona's tab answering, is the `/live` scenario `persona-tabs`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { reactive } from 'vue';
import { postprocess } from '@lumenize/structured-clone';
import { answerRunRequests, createNebulaClient, TREE_WAIT_MS } from '../../../../packages/resources/src/frontend/create-nebula-client';

const STUDIO = 'https://crm.acme.lumenize.dev';

const post = (origin: string, data: unknown, source: unknown = window.parent) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: source as Window }));

/**
 * Every `lumenize:ran` the page posted to its parent, in order. A value is read as Studio reads
 * it: cloned as `postMessage` clones, which refuses a Vue proxy, then decoded by the codec.
 */
function answers() {
  const ran: Array<{ id: unknown; ok: boolean; value?: unknown; error?: string; noSession?: boolean; to: string; sentValue: boolean }> = [];
  const spy = vi.spyOn(window.parent, 'postMessage').mockImplementation(((msg: any, to: string) => {
    if (msg?.type !== 'lumenize:ran') return;
    const value = msg.ok ? postprocess(structuredClone(msg.encoded)) : undefined;
    ran.push({ id: msg.id, ok: msg.ok, value, error: msg.error, noSession: msg.noSession, to, sentValue: 'value' in msg });
  }) as never);
  return { ran, spy };
}

const client = { claims: { sub: 'gerry-sub' }, double: (n: number) => n * 2 };
/** A store the org tree has reached, as a connected page's is a moment after it connects. */
const store = { resources: { Deal: {} }, lmz: { orgTree: { value: { nodes: new Map([['n1', { slug: 'deals', label: 'Deals' }]]), edges: new Set(['root:n1']) } } } };

describe('answerRunRequests', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs the code with client and store in scope, waits for its Promise, and posts the value to the parent', async () => {
    // Mutations: answer without awaiting the code → the value is a Promise → red; drop `client` or
    // `store` from the function's scope → a ReferenceError comes back → red.
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, {
        type: 'lumenize:run', id: 'r1',
        code: "await new Promise((r) => setTimeout(r, 5)); return { sub: client.claims.sub, four: client.double(2), types: Object.keys(store.resources) }",
      });
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(ran[0]).toEqual({ id: 'r1', ok: true, value: { sub: 'gerry-sub', four: 4, types: ['Deal'] }, error: undefined, noSession: undefined, to: STUDIO, sentValue: false });
    } finally {
      remove();
    }
  });

  it('answers a throw as a result that names the error, not as silence', async () => {
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'r2', code: "throw new TypeError('no such deal')" });
      post(STUDIO, { type: 'lumenize:run', id: 'r3', code: 'return nope.field' });
      await vi.waitFor(() => expect(ran).toHaveLength(2));
      // A throw is the code's own answer, so it is no sign the page lacks a session.
      expect(ran.find((a) => a.id === 'r2')).toMatchObject({ ok: false, error: 'TypeError: no such deal', noSession: undefined });
      expect(ran.find((a) => a.id === 'r3')).toMatchObject({ ok: false, error: 'ReferenceError: nope is not defined' });
    } finally {
      remove();
    }
  });

  it('runs only once the client is ready, and says it has no session when it never will be', async () => {
    // Mutation: drop the wait on `ready` → the code runs before the client connects → red.
    const { ran } = answers();
    let connect!: () => void;
    const order: string[] = [];
    const ready = new Promise<void>((resolve) => { connect = () => { order.push('ready'); resolve(); }; });
    const remove = answerRunRequests({ parentOrigin: STUDIO, client: { ran: () => { order.push('ran'); return 1; } }, store, ready });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'w1', code: 'return client.ran()' });
      await Promise.resolve();
      expect(order).toEqual([]);
      connect();
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(order).toEqual(['ready', 'ran']);
    } finally {
      remove();
    }
    const failed = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.reject(new Error('No refresh cookie covers this host')) });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'w2', code: 'return 1' });
      await vi.waitFor(() => expect(ran).toHaveLength(2));
      // `noSession` is what tells Studio to load the page again later, as for a persona not yet accepted.
      expect(ran[1]).toMatchObject({ id: 'w2', ok: false, noSession: true, error: 'Error: No refresh cookie covers this host' });
    } finally {
      failed();
    }
  });

  it('answers with the value as it is: a Map, a Set, a Date, a bigint, an Error and a cycle arrive as themselves', async () => {
    // The page encodes with the codec (ADR-002), since `postMessage` cannot carry a Vue proxy and
    // JSON turns a Map into `{}`. Mutations: send the value as JSON has it → `nodes` arrives an
    // object, not a Map → red; send it unencoded → a reactive store's value cannot be cloned → red.
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store: reactive(store), ready: Promise.resolve() });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 'c1', code: 'return { tree: store.lmz.orgTree.value, big: 10n, when: new Date(0), nothing: undefined, nan: NaN, failed: Object.assign(new TypeError("no such deal"), { retryable: true }) }' });
      post(STUDIO, { type: 'lumenize:run', id: 'c2', code: 'const a = { name: "a" }; a.self = a; return a' });
      post(STUDIO, { type: 'lumenize:run', id: 'c3', code: 'return' });
      await vi.waitFor(() => expect(ran).toHaveLength(3));
      const whole = ran.find((a) => a.id === 'c1')!;
      expect([whole.ok, whole.sentValue]).toEqual([true, false]);
      const value = whole.value as { tree: { nodes: Map<string, unknown>; edges: Set<string> }; big: bigint; when: Date; nan: number; failed: Error & { retryable?: boolean } };
      expect(value.tree.nodes).toBeInstanceOf(Map);
      expect([...value.tree.nodes]).toEqual([['n1', { slug: 'deals', label: 'Deals' }]]);
      expect(value.tree.edges).toBeInstanceOf(Set);
      expect([...value.tree.edges]).toEqual(['root:n1']);
      expect(value.big).toBe(10n);
      expect(value.when).toBeInstanceOf(Date);
      expect(value.when.getTime()).toBe(0);
      expect('nothing' in value).toBe(true);
      expect(value.nan).toBeNaN();
      // A transaction's `infrastructure-error` outcome carries an Error, with fields of its own.
      expect(value.failed).toBeInstanceOf(TypeError);
      expect([value.failed.message, value.failed.retryable]).toEqual(['no such deal', true]);
      const cyclic = ran.find((a) => a.id === 'c2')!;
      expect(cyclic.ok).toBe(true);
      expect((cyclic.value as { self: unknown }).self).toBe(cyclic.value);
      expect(ran.find((a) => a.id === 'c3')).toMatchObject({ ok: true, value: undefined });
    } finally {
      remove();
    }
  });

  it('answers a value the codec cannot hold as an error that says so', async () => {
    // A symbol has no encoding. Mutation: answer nothing when the encoding throws → the run
    // waits out Studio's bound.
    const { ran } = answers();
    const remove = answerRunRequests({ parentOrigin: STUDIO, client, store, ready: Promise.resolve() });
    try {
      post(STUDIO, { type: 'lumenize:run', id: 's1', code: 'return { tag: Symbol("x") }' });
      await vi.waitFor(() => expect(ran).toHaveLength(1));
      expect(ran[0]!.ok).toBe(false);
      expect(ran[0]!.error).toContain('the code ran, and its value could not be sent back');
    } finally {
      remove();
    }
  });

  it('waits for the org tree to reach the store before it runs, and no longer than its bound', async () => {
    // The tree arrives a moment after the connection, and code looks a node up in it. Mutations:
    // drop the wait → the first run reads no tree → red; wait with no bound → the second never runs.
    vi.useFakeTimers();
    try {
      const { ran } = answers();
      const late: { lmz: { orgTree: { value?: unknown } } } = { lmz: { orgTree: {} } };
      const remove = answerRunRequests({ parentOrigin: STUDIO, client, store: late, ready: Promise.resolve() });
      try {
        post(STUDIO, { type: 'lumenize:run', id: 't1', code: 'return store.lmz.orgTree.value.root' });
        await vi.advanceTimersByTimeAsync(200);
        expect(ran).toEqual([]);
        late.lmz.orgTree.value = { root: 'r' };
        await vi.advanceTimersByTimeAsync(100);
        expect(ran).toMatchObject([{ id: 't1', ok: true, value: 'r' }]);
      } finally {
        remove();
      }
      const never = answerRunRequests({ parentOrigin: STUDIO, client, store: { lmz: { orgTree: {} } }, ready: Promise.resolve() });
      try {
        post(STUDIO, { type: 'lumenize:run', id: 't2', code: 'return typeof store.lmz.orgTree.value' });
        await vi.advanceTimersByTimeAsync(TREE_WAIT_MS - 200);
        expect(ran).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(400);
        expect(ran[1]).toMatchObject({ id: 't2', ok: true, value: 'undefined' });
      } finally {
        never();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // Each row is a request the listener must not run. The request after it, from Studio's own
  // origin and window, is the barrier and the positive control: it is answered, and it alone.
  it.each([
    ['from the parent at another origin', () => post('https://evil.example', { type: 'lumenize:run', id: 'n', code: 'return 1' })],
    ['at Studio\'s origin from a window that is not the parent', () => post(STUDIO, { type: 'lumenize:run', id: 'n', code: 'return 1' }, {})],
    ['of another type', () => post(STUDIO, { type: 'lumenize:reload', id: 'n', code: 'return 1' })],
    ['whose code is not a string', () => post(STUDIO, { type: 'lumenize:run', id: 'n', code: { toString: () => 'return 1' } })],
  ])('runs nothing for a request %s', async (_name, refusedRequest) => {
    const { ran } = answers();
    const ranCode = vi.fn(() => 1);
    const remove = answerRunRequests({ parentOrigin: STUDIO, client: { ranCode }, store, ready: Promise.resolve() });
    try {
      refusedRequest();
      post(STUDIO, { type: 'lumenize:run', id: 'p', code: 'return client.ranCode()' });
      await vi.waitFor(() => expect(ran.some((a) => a.id === 'p')).toBe(true));
      expect(ran.map((a) => a.id)).toEqual(['p']);
      expect(ranCode).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });
});

describe('createNebulaClient answers a run request only on a framed dev Star page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
  });

  const page = (meta: Record<string, unknown>, framed: boolean, config: { parentOrigin?: string } = {}) => {
    document.head.querySelectorAll('meta').forEach((m) => m.remove());
    const m = document.createElement('meta');
    m.name = 'nebula-scope';
    m.content = JSON.stringify(meta);
    document.head.appendChild(m);
    vi.spyOn(window, 'top', 'get').mockReturnValue(framed ? {} as Window : window);
    // No session: `ready` rejects, so a page that listens answers `ok: false` with why, and the
    // answer itself is what shows it listened.
    return createNebulaClient({
      platformOrigin: 'https://platform.lumenize.dev',
      baseUrl: 'https://dev.crm.acme.lumenize.dev',
      fetch: async () => new Response('{"error":"no_session"}', { status: 401 }),
      sessionStorage: undefined,
      // A top-level page with no session would otherwise be sent to log in, which jsdom cannot do.
      onLoginRequired: () => {},
      ...config,
    });
  };

  // Mutation: drop the factory's `dev` condition or its frame condition → that row's page answers
  // `n` too → red. The second row is the frame condition's own: its config names a parent origin
  // on a page nobody frames, which the meta alone never does, and a top-level window is its own
  // parent, so a listener there would obey the post. A page that names no parent origin has no
  // row: its listener would obey nothing whatever the factory decided.
  it.each([
    ['is not framed', { dev: true, parentOrigin: STUDIO }, false, {}],
    ['is not framed, though its config names a parent origin', { dev: true }, false, { parentOrigin: STUDIO }],
    ['the serving layer did not mark as a dev Star\'s', { parentOrigin: STUDIO }, true, {}],
  ])('a page that %s runs nothing, and a framed dev page beside it does', async (_name, meta, framed, config) => {
    const { ran } = answers();
    const refusing = page(meta, framed, config);
    await refusing.ready.catch(() => { /* no session, by construction */ });
    post(STUDIO, { type: 'lumenize:run', id: 'n', code: 'return 1' });
    const listening = page({ dev: true, parentOrigin: STUDIO }, true);
    try {
      await listening.ready.catch(() => { /* no session, by construction */ });
      post(STUDIO, { type: 'lumenize:run', id: 'p', code: 'return 1' });
      await vi.waitFor(() => expect(ran.some((a) => a.id === 'p')).toBe(true));
      // One answer to `p`, from the listening page alone, and none to `n` from either.
      expect(ran.map((a) => a.id)).toEqual(['p']);
      expect(ran[0]).toMatchObject({ ok: false, noSession: true, to: STUDIO });
    } finally {
      await refusing.dispose();
      await listening.dispose();
    }
  });
});
