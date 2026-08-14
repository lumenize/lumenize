/**
 * A todo app built on the route runner. It has nothing to do with Nebula, which is the point:
 * if the runner needed a Registry concept to be usable, this app could not be written against it.
 *
 * Lives under `test/` rather than `src/` because it is a fixture — `vitest.config.js` counts
 * `src/**` toward coverage, and a todo app is not shipped source.
 */
import {
  createRouter,
  type RouteEntry,
  type RouteState,
  type Step,
} from '../../src/route-pipeline';

type Todo = { id: string; title: string };

/** What `authGuard` adds once it has resolved a caller. */
type Authed = { token: string };

const TOKENS = new Set(['t-alice', 't-bob']);

/** Stands in for a lookup that would hit a store — the reason the guard is async. */
async function resolveToken(header: string | null): Promise<string | undefined> {
  await Promise.resolve();
  return header !== null && TOKENS.has(header) ? header : undefined;
}

export function createTodoApp() {
  const todos = new Map<string, Todo>();
  /** Every step that ran, in order. The app's audit trail, and what proves a step did NOT run. */
  const audit: string[] = [];

  const auditStep: Step = (request) => {
    audit.push(`audit ${new URL(request.url).pathname}`);
  };

  /** Stamps a correlation id by REPLACING the request, so later steps see it. */
  const requestIdStep: Step = (request) => {
    audit.push('requestId');
    // ⚠️ Measured through a real `SELF.fetch()`: an INCOMING request's headers are immutable, while
    // a test-constructed one's are not — so `request.headers.set(...)` would pass in this fixture and
    // throw in production. The test *leaves the request it was handed unmodified* is what holds that
    // line; without it the fixture is more permissive than the runtime.
    const headers = new Headers(request.headers);
    headers.set('x-request-id', crypto.randomUUID());
    return new Request(request, { headers });
  };

  const authGuard: Step<{}, Authed> = async (request, state) => {
    audit.push('auth');
    const token = await resolveToken(request.headers.get('authorization'));
    if (token === undefined) return new Response('Unauthorized', { status: 401 });
    state.token = token;
  };

  /** Runs after `authGuard` and reads what it added — a step-to-step hop, not a step-to-handler one. */
  const auditActorStep: Step<Authed> = (_request, routeState) => {
    audit.push(`actor ${routeState.token}`);
  };

  const handleHealth: Step = () => {
    audit.push('health');
    return new Response('ok');
  };

  const handleAddTodo: Step<RouteState & Authed> = async (request, state) => {
    audit.push('addTodo');
    const { title } = (await request.json()) as { title: string };
    const todo: Todo = { id: crypto.randomUUID(), title };
    todos.set(todo.id, todo);
    return Response.json(
      { ...todo, by: state.token, requestId: request.headers.get('x-request-id') },
      { status: 201 },
    );
  };

  const handleGetTodo: Step<RouteState & Authed> = (_request, state) => {
    audit.push('getTodo');
    const todo = todos.get(state.params.id);
    if (todo === undefined) return new Response('No such todo', { status: 404 });
    return Response.json({ ...todo, by: state.token });
  };

  const handleListTodos: Step<Authed> = (_request, state) => {
    audit.push('listTodos');
    return Response.json({ todos: [...todos.values()], by: state.token });
  };

  /** A literal path that also matches the `/todos/:id` pattern — order is what separates them. */
  const handleArchive: Step = () => {
    audit.push('archive');
    return Response.json({ archived: [...todos.values()].length });
  };

  /**
   * Takes any verb, and reports whether the caller was authenticated. It declares `Partial<Authed>`
   * because it reads `token` without requiring it — which is also how a leak would show: `/version`
   * has no auth step, so a populated `token` here means state survived from an earlier run.
   */
  const handleVersion: Step<Partial<Authed>> = (request, state) => {
    audit.push('version');
    return Response.json({ version: '1', method: request.method, caller: state.token ?? 'anonymous' });
  };

  // ⚠️ ORDER IS MEANING: the scan takes the first entry whose path matches AND whose method fits,
  // so `/todos/archive` must precede `/todos/:id`, which would otherwise swallow it.
  const routes: RouteEntry[] = [
    { path: '/health', method: 'GET', steps: [handleHealth] },
    { path: '/version', steps: [handleVersion] }, // no method — any verb
    { path: '/todos', method: 'GET', steps: [auditStep, authGuard, handleListTodos] },
    { path: '/todos', method: 'POST', steps: [auditStep, requestIdStep, authGuard, auditActorStep, handleAddTodo] },
    { path: '/todos/archive', method: 'GET', steps: [handleArchive] },
    { path: '/todos/:id', method: 'GET', steps: [auditStep, authGuard, handleGetTodo] },
    // Registered but not implemented yet — an empty list must not read as an absent route.
    { path: '/todos/:id', method: 'PATCH', steps: [] },
  ];

  const run = createRouter(routes);

  return {
    audit,
    /** The app's own entry point: the runner returns `undefined` for an unknown path, and the app 404s. */
    async fetch(request: Request): Promise<Response> {
      const response = await run(request);
      return response ?? new Response('Not Found', { status: 404 });
    },
    /** Exposed so a test can drive the runner directly and see the `undefined` the app would swallow. */
    run,
  };
}
