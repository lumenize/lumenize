/**
 * A chain a node started carries no claims, and passage reads its `activeScope` from the node that
 * started it: that node's name, when it is a scope, held as a plain member with no `scopeAdmin`
 * (`ScopedMeshDO`'s `claimsForPassage`). A chain a node named by an id started has none.
 *
 * In-lane, because no product path makes a Star call its sibling or a Profile start a chain into a
 * Star, and a harness helper that made one would be a fixture (`live-scenarios.md`). Each test
 * starts a fresh chain on a real node, outside any mesh call, and reads the outcome its handler
 * stored: the value `admitted`, or the refusal's message. A positive control's value also proves
 * the fire-back was admitted at the caller, whose chain is the caller calling itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

const universe = () => `ncp-${crypto.randomUUID().slice(0, 8)}`;

/** Start a fresh chain on `from`, calling `admitted` at `to`, and return what its handler stored. */
async function freshChain(
  fromBinding: 'STAR' | 'GALAXY' | 'PROFILE', from: string, toBinding: 'STAR' | 'GALAXY', to: string,
): Promise<string> {
  const stub = (env as any)[fromBinding].getByName(from);
  await (runInDurableObject as any)(stub, (instance: any) => {
    // The step the mesh takes on a node's first call, here done by hand for a node no call reached.
    instance.lmz.__init({ bindingName: fromBinding, instanceName: from });
    instance.callFreshChain(toBinding, to);
  });
  return vi.waitFor(async () => {
    const outcome = await (runInDurableObject as any)(stub,
      (_instance: unknown, ctx: DurableObjectState) => ctx.storage.kv.get<string>('fresh_chain_outcome'));
    expect(outcome).toBeDefined();
    return outcome as string;
  }, { timeout: 10_000 });
}

describe('a chain a node started: passage from the starting node\'s scope', () => {
  it('a Star calling its sibling is refused, by a message naming the Star', async () => {
    const u = universe();
    expect(await freshChain('STAR', `${u}.app.a`, 'STAR', `${u}.app.b`))
      .toBe(`Error: No passage from "${u}.app.a" into "${u}.app.b"`);
  });

  it('a chain a Profile started is refused at a Star, since its id is no scope', async () => {
    const u = universe();
    expect(await freshChain('PROFILE', crypto.randomUUID(), 'STAR', `${u}.app.a`))
      .toBe(`Error: No passage from "(no scope)" into "${u}.app.a"`);
  });

  it('a Galaxy\'s chain into one of its Stars is refused: a plain member, with no dominion', async () => {
    const u = universe();
    expect(await freshChain('GALAXY', `${u}.app`, 'STAR', `${u}.app.a`))
      .toBe(`Error: No passage from "${u}.app" into "${u}.app.a"`);
  });

  it('positive controls: a Star calling itself, and calling its Galaxy, are both admitted', async () => {
    const u = universe();
    expect(await freshChain('STAR', `${u}.app.a`, 'STAR', `${u}.app.a`)).toBe('admitted');
    expect(await freshChain('STAR', `${u}.app.b`, 'GALAXY', `${u}.app`)).toBe('admitted');
  });
});
