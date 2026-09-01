/**
 * Phase 7: the Home screen's decisions, asserted where a `v-if` chain could not be.
 *
 * Four of these decide something a person experiences and would not obviously notice going wrong:
 *
 *  - **Which modal a row opens.** The invite flavor names a sender; the self flavor warns that
 *    nobody should be here unless they started it. Showing the wrong one to the wrong person is a
 *    real failure, not a cosmetic one.
 *  - **Whether a row is clickable at all.** Two rows have no surface, and `undefined` is the answer
 *    rather than a gap to fill.
 *  - **Whether Home is skipped entirely.** Fast-forwarding past an unaccepted membership would carry
 *    someone through consent into a session that immediately refuses them.
 *  - **Whether Accept can fire.** The checkbox is what makes the modal a decision.
 */
import { describe, it, expect } from 'vitest';
import {
  modalFlavorFor, canAccept, surfaceFor, rendersExpanded, fastForwardTarget, crossEmailNotice, authHintFor,
  RENDER_ALL_THRESHOLD, PLATFORM_SCOPE, type ScopeNode, type ScopeSummary,
} from '../../../nebula-studio-ui/src/auth/home-logic';

const node = (over: Partial<ScopeNode> & { scope: string; tier: ScopeNode['tier'] }): ScopeNode => over;

describe('which consent modal a row needs', () => {
  it('an unaccepted INVITED membership gets the invite flavor', () => {
    expect(modalFlavorFor(node({
      scope: 'acme.crm', tier: 'galaxy', accepted: false, invitedByName: 'Dana',
    }))).toBe('invite');
  });

  it('an unaccepted membership with an inviter but NO name is still an invitation', () => {
    // The name is sender-supplied and optional; the attribution stamp is what marks an invitation.
    // Reds against keying the flavor on the display name, which would show a stranger the
    // "you started this" warning for something they did not start.
    expect(modalFlavorFor(node({
      scope: 'acme.crm', tier: 'galaxy', accepted: false, invitedByProfileId: 'p-123',
    }))).toBe('invite');
  });

  it('an unaccepted SELF-CREATED membership gets the self flavor', () => {
    expect(modalFlavorFor(node({ scope: 'acme', tier: 'universe', accepted: false }))).toBe('self');
  });

  it('an ACCEPTED membership needs no modal', () => {
    expect(modalFlavorFor(node({ scope: 'acme', tier: 'universe', accepted: true }))).toBeUndefined();
  });

  it('a DESCENDANT is never consented to individually', () => {
    // Descendants arrive with no `accepted` field at all — they are reached through a membership,
    // not held. Reds against a truthiness test, which would read `undefined` as unaccepted and open
    // a modal for every node in the tree.
    expect(modalFlavorFor(node({ scope: 'acme.crm.acct', tier: 'star' }))).toBeUndefined();
  });
});

describe('Accept is gated on the checkbox', () => {
  it('is disabled until checked', () => {
    expect(canAccept(false)).toBe(false);
    expect(canAccept(true)).toBe(true);
  });
});

describe('where a row goes', () => {
  it('a Star goes to its app and a Galaxy to its Studio', () => {
    expect(surfaceFor(node({ scope: 'acme.crm.acct', tier: 'star' }))).toBe('/app/acme.crm.acct');
    expect(surfaceFor(node({ scope: 'acme.crm', tier: 'galaxy' }))).toBe('/studio/acme.crm');
  });

  it('a Universe has no surface yet — it renders unclickable', () => {
    expect(surfaceFor(node({ scope: 'acme', tier: 'universe' }))).toBeUndefined();
  });

  it('the platform root has no surface — because it is a universe', () => {
    // ⚠️ **This asserts the reachable input only, and the reason matters.** The server derives tier
    // from segment count, so `nebula-platform` (one segment) can only ever arrive as a universe;
    // a `{ scope: PLATFORM_SCOPE, tier: 'galaxy' }` node is not constructible, and asserting over it
    // would be testing an input production cannot produce. An explicit platform guard was written
    // and deleted for exactly that reason — see `surfaceFor`'s JSDoc, which records the obligation
    // that comes due when universes gain a surface.
    expect(surfaceFor(node({ scope: PLATFORM_SCOPE, tier: 'universe' }))).toBeUndefined();
  });
});

describe('how wide a level renders', () => {
  it('expands at the threshold and collapses past it', () => {
    const many = (n: number) => Array.from({ length: n }, () => ({}));
    expect(rendersExpanded(many(RENDER_ALL_THRESHOLD))).toBe(true);
    expect(rendersExpanded(many(RENDER_ALL_THRESHOLD + 1))).toBe(false);
    expect(rendersExpanded(undefined)).toBe(true); // nothing to collapse
  });
});

describe('the single-Star fast-forward', () => {
  const summary = (memberships: ScopeNode[]): ScopeSummary =>
    ({ emails: [{ email: 'a@example.com', current: true, memberships }] });

  it('one ACCEPTED Star skips Home', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm.acct', tier: 'star', accepted: true }),
    ]))).toBe('/app/acme.crm.acct');
  });

  it('one UNACCEPTED Star does NOT skip Home', () => {
    // ⚠️ The important one. Fast-forwarding here would carry the person past their consent modal
    // into a surface whose session is inert — they would arrive somewhere that refuses them, with no
    // way to accept. Reds against dropping the `accepted` conjunct.
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm.acct', tier: 'star', accepted: false }),
    ]))).toBeUndefined();
  });

  it('one accepted GALAXY does not skip Home', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm', tier: 'galaxy', accepted: true }),
    ]))).toBeUndefined();
  });

  it('two memberships never skip Home, even when both are accepted Stars', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'a.b.c', tier: 'star', accepted: true }),
      node({ scope: 'd.e.f', tier: 'star', accepted: true }),
    ]))).toBeUndefined();
  });

  it('memberships spread across two ADDRESSES are still two memberships', () => {
    // Reds against counting per-section instead of per-person — the summary is `profileId`-keyed,
    // so someone with one Star on each of two addresses has a choice to make.
    expect(fastForwardTarget({
      emails: [
        { email: 'a@example.com', current: true, memberships: [node({ scope: 'a.b.c', tier: 'star', accepted: true })] },
        { email: 'b@example.com', memberships: [node({ scope: 'd.e.f', tier: 'star', accepted: true })] },
      ],
    })).toBeUndefined();
  });
});

describe('the hand-off hint', () => {
  it('keys on the DESTINATION and carries the AUTH scope', () => {
    // ⚠️ Reversing these is silent: it writes a real entry Studio reads, and Studio then refreshes
    // against a path holding no cookie. Jennifer entering a Galaxy from her Universe session is the
    // live case — her cookie is at `acme`, the destination is `acme.crm`.
    expect(authHintFor('acme.crm', 'acme')).toEqual({
      key: 'nebula.authScope:acme.crm', value: 'acme',
    });
  });

  it('matches the key App.vue actually reads', () => {
    // The prefix is Studio's, not ours — asserted literally so a rename there reds here rather than
    // silently orphaning every hand-off.
    expect(authHintFor('x.y', 'x').key).toBe('nebula.authScope:x.y');
  });
});

describe('the cross-email banner', () => {
  it('names the address that would be emailed, and stays off the current one', () => {
    expect(crossEmailNotice({ email: 'jen@gmail.com', memberships: [] }))
      .toBe('Signing in here emails jen@gmail.com');
    expect(crossEmailNotice({ email: 'jen@work.com', current: true, memberships: [] }))
      .toBeUndefined();
  });
});
