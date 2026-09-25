/**
 * Which member kinds `@mesh()` marks, and what the entry rule does with each.
 *
 * **Why this tier and not `/live`** (`.claude/rules/live.md` puts that reason on the test file,
 * which outlives the task file): these are properties of the decorator and the executor, and driving
 * them in `/live` would mean shipping a marked getter, a call recorder and a deliberately-unmarked
 * getter into `apps/nebula`'s production Star or Galaxy — where there is not one marked getter
 * today, and where the real gate pair belongs to a task that has not built it. Counting a getter
 * body's invocations is DO-internal control flow besides. This is the real mesh path, never
 * `createTestingClient`, and every recorder is read back THROUGH the mesh rather than from stdio.
 */
import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { mesh, isMeshCallable } from '../src/mesh-decorator';

/** Fire `chain` at the DO over a real hop and keep what its handler recorded. */
async function wire(name: string, chain: unknown[]): Promise<string> {
  const caller = env.TEST_DO.getByName(`mk-caller-${name}`);
  await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: `mk-caller-${name}` });
  await caller.clearMarkerProbe();
  caller.testWireChainAt('MEMBER_KIND_DO', name, chain as never);
  await vi.waitFor(async () => {
    expect(await caller.getHandlerReceived()).toBeDefined();
  }, { timeout: 5000 });
  const received = await caller.getHandlerReceived() as unknown;
  return received instanceof Error ? `REFUSED: ${received.message}` : `PERMITTED: ${String(received)}`;
}

const GET = (key: string) => ({ type: 'get' as const, key });
const APPLY = (...args: unknown[]) => ({ type: 'apply' as const, args });

describe('@mesh() marks a method and a getter, and nothing else', () => {
  it('a marked METHOD reaches its target', async () => {
    expect(await wire('mk-method', [GET('markedMethod'), APPLY('x')]))
      .toBe('PERMITTED: method reached: x');
  });

  it('a marked GETTER reaches its target — the GETTER path, not a call', async () => {
    // Asserting on a call would be satisfied by a method-only implementation and leave the getter
    // entry unmeasured: op 0 here is a `get`, and nothing applies it.
    expect(await wire('mk-getter', [GET('markedGate'), GET('reached'), APPLY()]))
      .toBe('PERMITTED: facade reached');
  });

  it("a getter gate's guard runs BEFORE its body", async () => {
    const node = env.MEMBER_KIND_DO.getByName('mk-order');
    await node.clearTrace();
    await wire('mk-order', [GET('guardedGate'), GET('reached'), APPLY()]);
    expect(await node.getTrace()).toEqual(['guard', 'guarded getter body']);
  });

  it("a getter gate's body runs ONCE per chain", async () => {
    const node = env.MEMBER_KIND_DO.getByName('mk-once');
    await node.clearTrace();
    await wire('mk-once', [GET('markedGate'), GET('reached'), APPLY()]);
    expect(await node.getTrace()).toEqual(['getter body']);
  });

  it('an UNMARKED getter is refused WITHOUT running', async () => {
    // The property that justifies reading descriptors rather than `parent[key]`: deciding by
    // reading the member would run the very code the rule is deciding whether to admit.
    const node = env.MEMBER_KIND_DO.getByName('mk-unmarked');
    await node.clearTrace();
    expect(await wire('mk-unmarked', [GET('unmarkedGate'), GET('reached'), APPLY()]))
      .toMatch(/is not mesh-callable/);
    expect(await node.getTrace()).toEqual([]);
  });

  it('a getter entry returning a PROMISE fails, and fails obscurely — the measured answer', async () => {
    // The criterion allowed two outcomes — "refused with its own message, or proven to work". It is
    // NEITHER, and that is the finding: the walk awaits every `apply` but never a `get`, so the
    // Promise this getter returns is the value the NEXT op reads off, `reached` is `undefined`, and
    // the chain dies on the arity check with a message naming nothing useful.
    //
    // ⚠️ It cannot be made to fail better at the entry: `async get` is a syntax error in JS, so
    // there is no async-ness to detect on the descriptor — only a sync getter that happens to
    // return a thenable, which is knowable solely by calling it, which is what the descriptor walk
    // exists to avoid. This is why `mesh.md` states SYNCHRONOUS as an obligation a getter entry
    // owes rather than a rule the framework enforces. Filed under continuation ergonomics.
    //
    // ⚠️ Asserted as the specific string. The earlier `/PERMITTED|REFUSED/` matched every value
    // this helper can return, so it held on any tree — and hid exactly this.
    expect(await wire('mk-async', [GET('asyncGate'), GET('reached'), APPLY()]))
      .toMatch(/^REFUSED: TypeError: .* is not a function/);
  });
});

describe('an override does not inherit the mark, and the refusal says so', () => {
  // The mark lives on the function value, so a subclass override is a new function carrying
  // nothing. Left silent, this costs a hang with no error on either side.
  class Base { @mesh() handle(): string { return 'base'; } }
  class Bare extends Base { override handle(): string { return 'override'; } }
  class Remarked extends Base { @mesh() override handle(): string { return 'override'; } }

  it('names the OVERRIDE rather than emitting the generic refusal', async () => {
    const { executeOperationChain } = await import('../src/ocan/index');
    await expect(executeOperationChain([GET('handle'), APPLY()], new Bare()))
      .rejects.toThrow(/overrides a mesh-callable member but is not itself marked/);
  });

  it('a re-marked override works, which is the whole remedy', async () => {
    const { executeOperationChain } = await import('../src/ocan/index');
    expect(await executeOperationChain([GET('handle'), APPLY()], new Remarked())).toBe('override');
    expect(isMeshCallable(Remarked.prototype.handle)).toBe(true);
    expect(isMeshCallable(Bare.prototype.handle)).toBe(false);
  });

  it('still emits the GENERIC refusal when nothing is being shadowed', async () => {
    // Without this, a fix that always said "override" would satisfy the limb above.
    const { executeOperationChain } = await import('../src/ocan/index');
    class Plain { untouched(): string { return 'x'; } }
    await expect(executeOperationChain([GET('untouched'), APPLY()], new Plain()))
      .rejects.toThrow(/Member 'untouched' is not mesh-callable/);
  });
});

describe('the kinds that do NOT ship are refused twice over', () => {
  // The compiler is the primary net; the runtime refusal is what stops a compile-only check from
  // being the only one — an own-property fallback beside the descriptor walk would defeat it
  // silently, and nothing would go red.
  class Kinds {
    // @ts-expect-error — `accessor` is not a member kind `@mesh()` accepts.
    @mesh() accessor viaAccessor = { reached: () => 'accessor' };
    // @ts-expect-error — a field is not a member kind `@mesh()` accepts.
    @mesh() viaField = { reached: () => 'field' };
    @mesh() get viaGetter(): { reached: () => string } { return { reached: () => 'getter' }; }
    @mesh() viaMethod(): string { return 'method'; }
  }

  it('REFUSES an @mesh() accessor at runtime, not only at compile time', async () => {
    const { executeOperationChain } = await import('../src/ocan/index');
    await expect(executeOperationChain([GET('viaAccessor'), GET('reached'), APPLY()], new Kinds()))
      .rejects.toThrow(/is not mesh-callable/);
  });

  it('REFUSES an @mesh() field at runtime, not only at compile time', async () => {
    const { executeOperationChain } = await import('../src/ocan/index');
    await expect(executeOperationChain([GET('viaField'), GET('reached'), APPLY()], new Kinds()))
      .rejects.toThrow(/is not mesh-callable/);
  });

  it('PERMITS the two kinds that do ship, on the same class', async () => {
    // Without this, a signature that rejected everything would satisfy both limbs above.
    const { executeOperationChain } = await import('../src/ocan/index');
    const k = new Kinds();
    expect(await executeOperationChain([GET('viaGetter'), GET('reached'), APPLY()], k)).toBe('getter');
    expect(await executeOperationChain([GET('viaMethod'), APPLY()], k)).toBe('method');
  });
});

describe('what a node authored itself may still root anywhere', () => {
  it('runs a ctx-rooted handler on the fire-back, which the entry rule does not see', async () => {
    const caller = env.TEST_DO.getByName('ctx-rooted-caller');
    await caller.testLmzApiInit({ bindingName: 'TEST_DO', instanceName: 'ctx-rooted-caller' });
    caller.testCtxRootedHandler('TEST_DO', 'ctx-rooted-callee');
    await vi.waitFor(async () => {
      expect(await caller.getCtxRootedCache()).toBeDefined();
    }, { timeout: 5000 });
    expect(await caller.getCtxRootedCache()).toBe('echo: rooted-at-ctx');
  });
});
