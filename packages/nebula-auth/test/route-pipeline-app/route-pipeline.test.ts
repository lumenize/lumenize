// ⚠️ WHY THIS IS NOT A `/live` SCENARIO (`live.md` § *`/live` is the DEFAULT tier* requires the reason
// in the test): the runner reaches no DO, no identity and no browser, so a running Nebula has nothing
// for a scenario to be faithful to. A `wrangler dev` lane over this mini-app is possible and is
// declined as unnecessary, not impossible. Real `/live` coverage of the pipeline belongs to
// `tasks/nebula-registry-route-guards.md`, which carries a 🌐 criterion for it — the tier moved, it
// did not lapse.
import { describe, it, expect } from 'vitest';
import { createTodoApp } from './app';
import { createRouter, type RouteState, type Step } from '../../src/route-pipeline';

const AUTH = { authorization: 't-alice' };

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://todo.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://todo.test${path}`, { method: 'GET', headers });

/** Add one todo through the app and hand back its id. */
async function addTodo(app: ReturnType<typeof createTodoApp>, title = 'buy milk') {
  const res = await app.fetch(post('/todos', { title }, AUTH));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('the runner answers for itself', () => {
  it('returns undefined when no entry\'s path matches, and runs no step', async () => {
    const app = createTodoApp();

    // Driven through `run`, not `fetch` — the app's fallback would hide the undefined.
    expect(await app.run(get('/nope'))).toBeUndefined();
    expect(app.audit).toEqual([]);

    // And the app is what turns that into a 404.
    expect((await app.fetch(get('/nope'))).status).toBe(404);
  });

  it('returns 500 for a matched entry whose steps run out, distinguishable from no match', async () => {
    const app = createTodoApp();
    const id = await addTodo(app);

    // `/todos/:id` PATCH is registered with `steps: []`.
    const exhausted = await app.fetch(
      new Request(`https://todo.test/todos/${id}`, { method: 'PATCH' }),
    );
    expect(exhausted.status).toBe(500);
    expect((await app.fetch(get('/nope'))).status).toBe(404);

    // Same for a list whose last step returns undefined rather than an empty one.
    const fellThrough = createRouter([
      { path: '/x', steps: [() => undefined] },
    ]);
    expect((await fellThrough(get('/x')))?.status).toBe(500);
    expect(await fellThrough(get('/y'))).toBeUndefined();
  });
});

describe('the step contract', () => {
  it('lands path captures flat on routeState.params', async () => {
    const app = createTodoApp();
    const id = await addTodo(app, 'flat params');

    const res = await app.fetch(get(`/todos/${id}`, AUTH));
    expect(res.status).toBe(200);
    expect((await res.json()) as { title: string }).toMatchObject({ title: 'flat params' });
  });

  it('short-circuits on a Response, leaving later steps unrun', async () => {
    const app = createTodoApp();

    // No authorization header: the async authGuard refuses.
    const res = await app.fetch(post('/todos', { title: 'never stored' }));
    expect(res.status).toBe(401);
    expect(app.audit).toContain('auth');
    expect(app.audit).not.toContain('addTodo');
  });

  it('replaces the request for later steps when a step returns one', async () => {
    const app = createTodoApp();

    const res = await app.fetch(post('/todos', { title: 'stamped' }, AUTH));
    const body = (await res.json()) as { requestId: string | null };
    // `requestIdStep` returned a replacement; `handleAddTodo` reads the header off it.
    expect(body.requestId).toEqual(expect.any(String));
  });

  it('continues past a step that returns undefined', async () => {
    const app = createTodoApp();
    await addTodo(app);

    // auditStep and requestIdStep both return undefined; the handler still ran.
    expect(app.audit).toEqual(['audit /todos', 'requestId', 'auth', 'actor t-alice', 'addTodo']);
  });

  it('threads routeState from one step to a later one', async () => {
    const app = createTodoApp();
    const res = await app.fetch(post('/todos', { title: 'threaded' }, AUTH));

    // `by` is the token the async authGuard put on the state; the handler read it.
    expect((await res.json()) as { by: string }).toMatchObject({ by: 't-alice' });
  });
});

describe('async steps', () => {
  it('awaits a step before narrowing, so an async Response short-circuits', async () => {
    const app = createTodoApp();

    // authGuard is genuinely async. Without the await its pending Promise is neither a Response
    // nor a Request, reads as "continue", and the handler answers 201 instead of 401.
    const res = await app.fetch(post('/todos', { title: 'fails open?' }));
    expect(res.status).toBe(401);
    expect(app.audit).not.toContain('addTodo');
  });

  it('lets an async rejection propagate uncaught', async () => {
    const boom: Step = async () => {
      await Promise.resolve();
      throw new Error('async boom');
    };
    const run = createRouter([{ path: '/boom', steps: [boom] }]);

    await expect(run(get('/boom'))).rejects.toThrow('async boom');
  });

  it('lets a synchronous throw propagate uncaught', async () => {
    const boom: Step = () => {
      throw new Error('sync boom');
    };
    const run = createRouter([{ path: '/boom', steps: [boom] }]);

    await expect(run(get('/boom'))).rejects.toThrow('sync boom');
  });
});

describe('the goal-3 check: a REST-shaped app the Registry could not produce', () => {
  it('lets two entries share a path, each verb reaching its own handler', async () => {
    const app = createTodoApp();
    await addTodo(app, 'shared path');

    // `GET /todos` and `POST /todos` are two entries with the same pattern. A scan that refused on
    // the first method mismatch would 405 this, because the GET entry is listed first.
    const listed = await app.fetch(get('/todos', AUTH));
    expect(listed.status).toBe(200);
    expect((await listed.json()) as { todos: unknown[] }).toMatchObject({
      todos: [{ title: 'shared path' }],
    });
  });

  it('separates a wrong verb from an absent route', async () => {
    const app = createTodoApp();

    // `/todos` exists; no entry takes DELETE.
    const wrongVerb = await app.run(new Request('https://todo.test/todos', { method: 'DELETE' }));
    expect(wrongVerb?.status).toBe(405);

    // `/nope` exists nowhere, so the runner declines and the app 404s.
    expect(await app.run(new Request('https://todo.test/nope', { method: 'DELETE' }))).toBeUndefined();
    expect((await app.fetch(new Request('https://todo.test/nope', { method: 'DELETE' }))).status).toBe(404);
  });

  it('lets an entry with no method take any verb', async () => {
    const app = createTodoApp();

    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await app.fetch(new Request('https://todo.test/version', { method }));
      expect(res.status).toBe(200);
      expect((await res.json()) as { method: string }).toMatchObject({ method });
    }
  });

  it('carries no state from one run to the next', async () => {
    const app = createTodoApp();

    const before = await app.fetch(get('/version'));
    expect((await before.json()) as { caller: string }).toMatchObject({ caller: 'anonymous' });

    // This run's authGuard puts a token on its own state.
    expect((await app.fetch(get('/todos', AUTH))).status).toBe(200);

    // /version has no auth step, so a token here would mean the state object outlived its run.
    const after = await app.fetch(get('/version'));
    expect((await after.json()) as { caller: string }).toMatchObject({ caller: 'anonymous' });
  });

  it('resolves two entries that both match by listing order', async () => {
    const app = createTodoApp();

    // `/todos/archive` and `/todos/:id` both match; the literal is listed first and wins.
    const res = await app.fetch(get('/todos/archive', AUTH));
    expect(res.status).toBe(200);
    expect((await res.json()) as { archived: number }).toMatchObject({ archived: 0 });
    expect(app.audit).toContain('archive');
    expect(app.audit).not.toContain('getTodo');
  });
});

// A type-level criterion, checked by `npm run type-check` rather than at runtime: a step reads only
// the slice it declared. Widening the runner's state parameter to a bag makes the directive unused,
// which type-check reports as an error — the property the hono decision rests on.
const declaresParamsOnly: Step<RouteState> = (_request, state) => {
  // @ts-expect-error — `token` is not in this step's Needs; only a step that declares it may read it.
  void state.token;
};
void declaresParamsOnly;

describe('the table is forgiving about verb spelling, and says what it would accept', () => {
  it('matches however the table spelled the method', async () => {
    // The platform uppercases `get` but NOT `patch`, so comparing the table raw would make a
    // lowercase entry silently unroutable. The table is normalised; the request is not.
    const run = createRouter([
      { path: '/lower', method: 'get', steps: [() => new Response('lower-ok')] },
      { path: '/odd', method: 'patch', steps: [() => new Response('odd-ok')] },
    ]);

    expect(await (await run(get('/lower')))?.text()).toBe('lower-ok');
    expect(
      await (await run(new Request('https://todo.test/odd', { method: 'PATCH' })))?.text(),
    ).toBe('odd-ok');
  });

  it('names the accepted verbs on a 405', async () => {
    const app = createTodoApp();

    const res = await app.run(new Request('https://todo.test/todos', { method: 'DELETE' }));
    expect(res?.status).toBe(405);
    // RFC 9110 §15.5.6 — only the table knows what the path would accept.
    expect(res?.headers.get('allow')).toBe('GET, POST');
  });
});
