/**
 * `prependActor` — the ONE shared RFC 8693 §4.1 chain-nesting implementation
 * (access-claims.ts), called by `apps/nebula`'s `#buildActingToken` and any later
 * cross-node mint path so the two cannot drift on the semantics.
 *
 * The property under test is PRESERVATION: the new actor becomes the OUTERMOST entry
 * and every pre-existing verified entry survives beneath it. A flatten/overwrite —
 * the wrong shape the helper exists to make unwritable — drops the delegation chain,
 * which is exactly what the depth-2 assertions here red on.
 */
import { describe, it, expect } from 'vitest';
import { prependActor, NEBULA_SUB } from '../src/access-claims';

describe('prependActor (RFC 8693 chain nesting, written once)', () => {
  it('no base: the actor pair becomes the whole chain (profileId spread conditionally)', () => {
    expect(prependActor(undefined, { sub: NEBULA_SUB, profileId: NEBULA_SUB }))
      .toEqual({ sub: NEBULA_SUB, profileId: NEBULA_SUB });
    // No explicit-undefined key — a JSON hop would drop it anyway, so the shapes must
    // agree byte-for-byte with buildNebulaJwtPayload's conditional spread.
    const bare = prependActor(undefined, { sub: 'agent:x' });
    expect(bare).toEqual({ sub: 'agent:x' });
    expect('profileId' in bare).toBe(false);
  });

  it('with a base: the actor is the NEW OUTERMOST entry and the base survives BENEATH (a flatten reds here)', () => {
    // The coach's verified entry (an impersonated session's token), then Nebula prepends.
    const coach = { sub: 'coach-sub', profileId: 'coach-profile' };
    const chain = prependActor(coach, { sub: NEBULA_SUB, profileId: NEBULA_SUB });
    expect(chain).toEqual({
      sub: NEBULA_SUB,
      profileId: NEBULA_SUB,
      act: { sub: 'coach-sub', profileId: 'coach-profile' },
    });
  });

  it('nests recursively: prepending onto a depth-2 base yields depth 3, order outermost-first', () => {
    const depth2 = prependActor({ sub: 'inner' }, { sub: 'middle' });
    const depth3 = prependActor(depth2, { sub: 'outer' });
    expect(depth3).toEqual({ sub: 'outer', act: { sub: 'middle', act: { sub: 'inner' } } });
  });

  it('does not mutate the base (the verified claims object is shared)', () => {
    const base = { sub: 'coach-sub' };
    prependActor(base, { sub: NEBULA_SUB });
    expect(base).toEqual({ sub: 'coach-sub' });
  });
});
