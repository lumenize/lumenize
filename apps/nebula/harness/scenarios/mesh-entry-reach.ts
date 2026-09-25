/**
 * What an ordinary browser session reaches past `@mesh` — driven end to end, through the Gateway.
 *
 * `tasks/mesh-entry-and-walk-gaps.md` measured every hole below against the executor directly. What
 * nobody had done was drive one from a REAL logged-in session to a REAL DO, which is the question
 * this scenario answers: the published client API is enough, and none of it needs Workers RPC.
 *
 * ⚠️ **Every payload is harmless.** `__defineGetter__` leaves an ENUMERABLE accessor, which would
 * be the one lasting hazard here — but nothing in `apps/nebula/src`, `packages/mesh/src` or
 * `packages/nebula-auth/src` uses `for...in` (checked 2026-09-24), and the key is one nothing reads,
 * so the write is inert for the life of the boot it lands in. `svc.sql(['SELECT 1'])` proves arbitrary SQL runs exactly as
 * well as a `DELETE` would; the env read names `PRIMARY_JWT_KEY`, a key SELECTOR (`"BLUE"`) and
 * never a key; the prototype write uses a key nothing in the system reads — never `scopeAdmin`,
 * which `hasDominionOver` tests. That matters because this same file runs against a DEPLOYED worker
 * under `HARNESS_TARGET_URL`.
 *
 * ⚠️ **Every limb runs, and the verdict comes at the end.** A scenario normally reddens on its first
 * failing limb and hides the rest (`.claude/rules/live.md`), which would defeat the whole point
 * here: the first run of this file is a MEASUREMENT of which holes are open, so each limb has to
 * report for itself. The table it prints is that measurement.
 */
import assert from 'node:assert/strict';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver } from '../lib/harness';

export const needsContainer = false;

/** A galaxy-tier scope: two segments, so `GALAXY` owns resources and carries the `dagTree()` gate. */
const SCOPE = 'claude-reach.app';

/** A key nothing in the framework, Nebula or the tests reads. Never `scopeAdmin`. */
const PROBE_KEY = '__lumenizeFenceProbe';

/** The entry rule's refusal. `mesh-callable` is the shipped vocabulary (`isMeshCallable`). */
const NOT_MESH_CALLABLE = /is not mesh-callable/;

interface Limb {
  name: string;
  /** What the chain must be refused ON — a boolean would let a boundary refusal stand in for this one. */
  pattern: RegExp;
  run: () => Promise<unknown>;
}

export async function run(stack: DevStack): Promise<void> {
  let driver: Driver | undefined;
  try {
    driver = await connectDriver(stack, { scope: SCOPE });
    const client = driver.client;
    /** Build a chain rooted at the client's continuation proxy and await its outcome. */
    const call = (build: (c: any) => any): Promise<unknown> =>
      client.lmz.callAsync('GALAXY', SCOPE, build(client.ctn() as any), { timeoutMs: 15_000 });

    const limbs: Limb[] = [
      // ── the entry rule: op 0 must name a member the host class marked ────────────────────
      {
        name: 'read env with no call at all',
        pattern: NOT_MESH_CALLABLE,
        run: () => call((c) => c.env.PRIMARY_JWT_KEY),
      },
      {
        name: 'read ctx with no call at all',
        pattern: NOT_MESH_CALLABLE,
        run: () => call((c) => c.ctx.id.name),
      },
      {
        name: 'the same env read, nested as an argument to a marked member',
        pattern: NOT_MESH_CALLABLE,
        run: () => call((c) => c.getOntologyVersion(c.env.PRIMARY_JWT_KEY)),
      },
      {
        name: 'svc.sql runs arbitrary SQL on the host',
        pattern: NOT_MESH_CALLABLE,
        run: () => call((c) => c.svc.sql(['SELECT 1'])),
      },
      {
        name: 'a nested svc chain as an argument to a marked member',
        pattern: NOT_MESH_CALLABLE,
        run: () => call((c) => c.getOntologyVersion(c.svc.sql(['SELECT 1']))),
      },

      // ── the walk rules: past a real gate, the doors JavaScript opens on every object ──────
      //    `dagTree()` is a shipped gate — a bare `@mesh()` on both Star and Galaxy that hands back
      //    a `DagTree` facade, with per-op auth inside it. Everything past that op is unchecked.
      {
        name: 'constructor past the dagTree() gate',
        pattern: /'constructor'/,
        run: () => call((c) => c.dagTree().constructor.name),
      },
      {
        name: '__proto__ past the gate',
        pattern: /'__proto__'/,
        run: () => call((c) => c.dagTree().__proto__.constructor.name),
      },
      {
        name: "__lookupGetter__('__proto__'), naming neither fenced key",
        pattern: /'__lookupGetter__'/,
        run: () => call((c) => c.dagTree().__lookupGetter__('__proto__').name),
      },
      {
        name: 'a Function.prototype member reached from a handed-back method',
        pattern: /Function\.prototype/,
        run: () => call((c) => c.dagTree().getState.bind.name),
      },
    ];

    const results: Array<{ name: string; refused: boolean; detail: string }> = [];
    for (const limb of limbs) {
      try {
        const value = await limb.run();
        results.push({ name: limb.name, refused: false, detail: `PERMITTED -> ${short(value)}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({
          name: limb.name,
          refused: limb.pattern.test(message),
          detail: limb.pattern.test(message) ? 'refused' : `refused on the WRONG message: ${short(message)}`,
        });
      }
    }

    // ── the WRITE limb, and it asserts the side effect rather than the refusal alone ────────
    //    A refused chain that wrote before it threw is a pass by message and a failure in fact, so
    //    the second call reads the key back through a fresh chain. A polluted `Object.prototype`
    //    is inherited by the DO instance itself, which is what makes the read-back possible at all.
    let wrote = 'not attempted';
    try {
      // `getGalaxyConfig()` is a marked member handing back a PLAIN object, so its `constructor`
      // is `Object` and its `prototype` really is `Object.prototype` — a facade's own class
      // prototype (`dagTree()`) pollutes only that facade's instances. The function argument
      // arrives as a get-only nested marker on a marked member, which is the one way a chain can
      // produce a function at all (a chain names `get` and `apply` and nothing else).
      await call((c) => c.getGalaxyConfig().constructor.prototype
        .__defineGetter__(PROBE_KEY, c.getGalaxyConfig));
      wrote = 'the write was PERMITTED';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wrote = /'constructor'/.test(message) ? 'refused at constructor' : `refused on the WRONG message: ${short(message)}`;
    }
    // The criterion is that nothing LANDED, which the read-back answers two ways: the key reads as
    // `undefined` because no write happened, or the read is itself refused once a bare `ctn()[key]`
    // stops being a permitted entry. Requiring the second alone would hold this limb red through
    // the phase that closes the write, for a property that phase does not own.
    let landed: boolean;
    let readBack: string;
    try {
      const value = await call((c) => c[PROBE_KEY]);
      landed = value !== undefined;
      readBack = `the key reads back as ${short(value)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      landed = false;
      readBack = NOT_MESH_CALLABLE.test(message)
        ? 'the key is unreachable' : `unreadable: ${short(message)}`;
    }
    results.push({
      name: 'a WRITE to Object.prototype past the gate',
      refused: wrote === 'refused at constructor' && !landed,
      detail: `${wrote}; ${readBack}`,
    });

    for (const r of results) {
      console.log(`${r.refused ? '✅' : '❌'} ${r.name.padEnd(64)} ${r.detail}`);
    }
    const open = results.filter((r) => !r.refused);
    assert.equal(open.length, 0,
      `${open.length} of ${results.length} chains a remote caller must not be able to run were not refused:\n` +
      open.map((r) => `  - ${r.name}: ${r.detail}`).join('\n'));
  } finally {
    driver?.dispose();
  }
}

/** Keep a printed value short, and never print anything that could be a secret in full. */
function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? String(value) : text.slice(0, 80);
}
