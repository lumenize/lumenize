import { DurableObject } from 'cloudflare:workers';
import { debug } from '@lumenize/debug';

// Each route is one way an error can leave a Worker or a Durable Object. The driver hits each one
// three times with n = 1..3. A message is constant across those hits unless the route exists to
// vary it, so whether three hits make one issue or three says what Issues groups on.

/** A line in @lumenize/debug's shape, written here so the console method can vary. */
function ourJson(
  route: string, level: string, message: string, data: Record<string, unknown>, timestamp = true,
): string {
  const log = {
    type: 'debug', level, namespace: `exp.${route}`, message,
    ...(timestamp ? { timestamp: new Date().toISOString() } : {}),
    data,
  };
  return JSON.stringify(log, null, 2);
}

function serialize(e: Error) {
  return { name: e.name, message: e.message, stack: e.stack };
}

const ok = (route: string) => new Response(`${route} done\n`);

// Two sites throwing the same message, for whether an Error groups by stack or by message.
function siteOne(): Error { return new Error('N same message from two sites'); }
function siteTwo(): Error { return new Error('N same message from two sites'); }

type Route = (n: number, env: Env) => Response | Promise<Response>;

const routes: Record<string, Route> = {
  // What Nebula does today: @lumenize/debug's error(), which writes through console.debug.
  a: (n) => {
    debug('exp.a').error('A certificate pack delete failed', { host: `h${n}.example`, error: 'upstream 503' });
    return ok('a');
  },
  // Our JSON at error level, byte-identical every hit: the control for b.
  b0: () => {
    console.error(ourJson('b0', 'error', 'B0 certificate pack delete failed', { host: 'h.example' }, false));
    return ok('b0');
  },
  // Our JSON at error level; the message is constant, the timestamp and data vary.
  b: (n) => {
    console.error(ourJson('b', 'error', 'B certificate pack delete failed', { host: `h${n}.example`, id: crypto.randomUUID() }));
    return ok('b');
  },
  // Our JSON at error level; the varying id is in the message.
  b2: (n) => {
    console.error(ourJson('b2', 'error', `B2 certificate pack ${crypto.randomUUID()} delete failed`, { host: `h${n}.example` }));
    return ok('b2');
  },
  // Our JSON at error level, with the Error as a second argument.
  c: (n) => {
    console.error(ourJson('c', 'error', 'C certificate pack delete failed', { host: `h${n}.example` }), new Error('C upstream 503'));
    return ok('c');
  },
  // Our JSON at error level, with the Error serialized inside it, stack included.
  d: (n) => {
    const e = new Error('D upstream 503');
    console.error(ourJson('d', 'error', 'D certificate pack delete failed', { host: `h${n}.example`, error: serialize(e) }));
    return ok('d');
  },
  // Message and data as separate arguments, the shape Workers Logs indexes as fields.
  e: (n) => {
    console.error('E certificate pack delete failed', { host: `h${n}.example`, id: crypto.randomUUID() });
    return ok('e');
  },
  // A bare Error from one site whose message varies: grouped by stack, or by message?
  f: () => {
    console.error(new Error(`F failed ${crypto.randomUUID()}`));
    return ok('f');
  },
  // Our JSON at warn level, expected to be ignored.
  g: (n) => {
    console.warn(ourJson('g', 'warn', 'G certificate pack delete slow', { host: `h${n}.example` }));
    return ok('g');
  },
  // An uncaught throw from one site whose message varies.
  h: () => {
    throw new Error(`H uncaught ${crypto.randomUUID()}`);
  },
  // A 500 with nothing logged.
  i: () => new Response('i failed\n', { status: 500 }),
  // In a Durable Object: our JSON at error level.
  j: async (n, env) => {
    await env.PROBE.getByName('probe').logJson(n);
    return ok('j');
  },
  // A Durable Object method that throws; the Worker catches it and answers 200.
  k: async (n, env) => {
    try { await env.PROBE.getByName('probe').throws(n); } catch { /* answered below */ }
    return ok('k');
  },
  // A Durable Object that catches its own throw and returns it as a value, as Mesh does.
  l: async (n, env) => {
    await env.PROBE.getByName('probe').returnsError(n);
    return ok('l');
  },
  // The same Error message logged from two different sites.
  n1: () => { console.error(siteOne()); return ok('n1'); },
  n2: () => { console.error(siteTwo()); return ok('n2'); },

  // Round 2: route a was detected through console.debug. These separate the JSON's level field
  // from the words in its message, and test where a stack inside the JSON is picked up.

  // Plain text through console.debug, with a failure word and no JSON.
  q: () => { console.debug('Q certificate pack delete failed'); return ok('q'); },
  // Our JSON through console.debug at level info, with a failure word.
  r: (n) => {
    console.debug(ourJson('r', 'info', 'R certificate pack delete failed', { host: `h${n}.example` }));
    return ok('r');
  },
  // Our JSON through console.debug at level error, with no failure word.
  t: (n) => {
    console.debug(ourJson('t', 'error', 'T certificate pack deleted', { host: `h${n}.example` }));
    return ok('t');
  },
  // console.error, but the JSON says info: which wins?
  u: (n) => {
    console.error(ourJson('u', 'info', 'U certificate pack delete failed', { host: `h${n}.example` }));
    return ok('u');
  },
  // console.log with the JSON at level error.
  v: (n) => {
    console.log(ourJson('v', 'error', 'V certificate pack delete failed', { host: `h${n}.example` }));
    return ok('v');
  },
  // Our JSON through console.debug at level error, the stack in a top-level `stack` field.
  w: (n) => {
    const e = new Error('W upstream 503');
    const log = JSON.parse(ourJson('w', 'error', 'W certificate pack delete failed', { host: `h${n}.example` }));
    console.debug(JSON.stringify({ ...log, stack: e.stack }, null, 2));
    return ok('w');
  },
  // Our JSON through console.debug at level error, a top-level `error` object holding the stack.
  x: (n) => {
    const e = new Error('X upstream 503');
    const log = JSON.parse(ourJson('x', 'error', 'X certificate pack delete failed', { host: `h${n}.example` }));
    console.debug(JSON.stringify({ ...log, error: serialize(e) }, null, 2));
    return ok('x');
  },
  // Round 3, after @lumenize/debug writes Errors and lifts their stack: the real logger at error.
  real: (n) => {
    debug('exp.real').error('REAL certificate pack delete failed', { host: `h${n}.example`, error: new Error('REAL upstream 503') });
    return ok('real');
  },
  // The real logger at warn with an Error, so its line carries a top-level stack. Does a stack
  // alone make a warning an issue? (`DEBUG` is set in wrangler.jsonc so warn prints.)
  realwarn: (n) => {
    debug('exp.realwarn').warn('REALWARN2 certificate pack delete slow', { host: `h${n}.example`, error: new Error('REALWARN upstream 503') });
    return ok('realwarn');
  },
  // Our JSON through console.debug at level error, then the Error as a second argument.
  y: (n) => {
    console.debug(ourJson('y', 'error', 'Y certificate pack delete failed', { host: `h${n}.example` }), new Error('Y upstream 503'));
    return ok('y');
  },
};

export class IssuesProbe extends DurableObject<Env> {
  logJson(n: number): void {
    console.error(ourJson('j', 'error', 'J certificate pack delete failed', { host: `h${n}.example`, id: crypto.randomUUID() }));
  }

  throws(_n: number): void {
    throw new Error('K durable object threw');
  }

  returnsError(_n: number): { name: string; message: string } {
    try {
      throw new Error('L caught in the object');
    } catch (e) {
      const { name, message } = e as Error;
      return { name, message };
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = routes[url.pathname.slice(1)];
    if (!route) return new Response(`routes: ${Object.keys(routes).join(' ')}\n`, { status: 404 });
    return route(Number(url.searchParams.get('n') ?? 0), env);
  },
} satisfies ExportedHandler<Env>;
