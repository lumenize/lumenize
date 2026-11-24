/**
 * The Home screen's decisions, asserted where a `v-if` chain could not be.
 *
 * Five of these decide something a person experiences and would not obviously notice going wrong:
 *
 *  - **Which modal a row opens.** The invite flavor names a sender; the self flavor warns that
 *    nobody should be here unless they started it. Showing the wrong one to the wrong person is a
 *    real failure, not a cosmetic one.
 *  - **Whether a row is clickable at all.** Two rows have no surface, and `undefined` is the answer
 *    rather than a gap to fill.
 *  - **Whether Home is skipped entirely.** Fast-forwarding past an unaccepted membership would carry
 *    someone through consent into a session that immediately refuses them.
 *  - **Whether Accept can fire.** The checkbox is what makes the modal a decision.
 *  - **Whether a row needs a fresh login.** Opening a row this browser holds no cookie for only
 *    answers 401 on its host, so Home marks it rather than sending the person there blind.
 *
 * Every surface is a scope's own host now, so `surfaceFor` and `fastForwardTarget` take the function
 * that spells one, and the tests pass a stand-in that names the scope it was asked for. Retired with
 * the path-scoped cookies it worked around: the hand-off hint (`authHintFor`), which told Studio
 * which cookie a destination's refresh should spend; every page's refresh now sends them all.
 */
import { describe, it, expect } from 'vitest';
import {
  modalFlavorFor, canAccept, surfaceFor, rendersExpanded, fastForwardTarget, pendingFor, homeFastForward, afterAcceptTarget,
  needsFreshLogin, offersAccountActions, offersAppDelete, RENDER_ALL_THRESHOLD, PLATFORM_SCOPE, type ScopeNode, type ScopeSummary, type HomeSummary,
} from '../../../nebula-studio-ui/src/auth/home-logic';

const node = (over: Partial<ScopeNode> & { scope: string; tier: ScopeNode['tier'] }): ScopeNode => over;
/** A stand-in for the host-spelling function: names the scope it was asked for. */
const urlFor = (scope: string) => `host-of:${scope}`;

describe('which consent modal a row needs', () => {
  it('an unaccepted INVITED membership gets the invite flavor', () => {
    expect(modalFlavorFor(node({
      scope: 'acme.crm', tier: 'galaxy', accepted: false, invited: true, invitedByName: 'Dana',
    }))).toBe('invite');
  });

  it('an unaccepted invitation with NO name and NO profileId is still an invitation', () => {
    // ⚠️ The case that broke it. Both attribution fields are optional, so an inviter who supplied no
    // display name on a token carrying no `profileId` yields a stamped row with every stamp null —
    // and `JSON.stringify` drops undefined keys, so the wire shape equalled a self-claim. Keying on
    // `invited` is what fixes it; this reds against going back to the attribution fields.
    expect(modalFlavorFor(node({
      scope: 'acme.crm', tier: 'galaxy', accepted: false, invited: true,
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
    expect(canAccept(false, 'Robin')).toBe(false);
    expect(canAccept(true, 'Robin')).toBe(true);
    // The nickname is the second condition, and whitespace is not a nickname.
    expect(canAccept(true, '')).toBe(false);
    expect(canAccept(true, '   ')).toBe(false);
  });
});

describe('where a row goes', () => {
  it('a Star goes to its app and a Galaxy to its Studio, each on its own host', () => {
    expect(surfaceFor(node({ scope: 'acme.crm.acct', tier: 'star' }), urlFor)).toBe('host-of:acme.crm.acct');
    expect(surfaceFor(node({ scope: 'acme.crm', tier: 'galaxy' }), urlFor)).toBe('host-of:acme.crm');
  });

  it('a Universe goes to its own page', () => {
    expect(surfaceFor(node({ scope: 'acme', tier: 'universe' }), urlFor)).toBe('host-of:acme');
  });

  it('the platform root has NO surface — the one universe that is surfaceless', () => {
    // ⚠️ The guard `surfaceFor`'s JSDoc promised would come due when universes gained a surface.
    // Reds against removing the `scope === PLATFORM_SCOPE` line: without it the platform root becomes
    // clickable into a host no scope spells. The input is reachable — the server always delivers
    // `_platform` as a one-segment universe — so this test can fail.
    expect(surfaceFor(node({ scope: PLATFORM_SCOPE, tier: 'universe' }), urlFor)).toBeUndefined();
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

describe('the fast-forward past Home', () => {
  const summary = (memberships: ScopeNode[]): ScopeSummary =>
    ({ emails: [{ email: 'a@example.com', memberships }] });

  it('one ACCEPTED Star skips Home', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm.acct', tier: 'star', accepted: true }),
    ]), urlFor)).toBe('host-of:acme.crm.acct');
  });

  it('one UNACCEPTED Star does NOT skip Home', () => {
    // ⚠️ The important one. Fast-forwarding here would carry the person past their consent modal
    // into a surface whose session is inert — they would arrive somewhere that refuses them, with no
    // way to accept. Reds against dropping the `accepted` conjunct.
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm.acct', tier: 'star', accepted: false }),
    ]), urlFor)).toBeUndefined();
  });

  it("one ACCEPTED Universe with no app skips Home to the account's page", () => {
    // An account whose apps were all deleted; there is no choice to present, so skip the one-item
    // picker. Reds against the old tier === 'star' conjunct, which dead-ended the exact persona
    // pre-alpha targets on an unclickable label.
    expect(fastForwardTarget(summary([
      node({ scope: 'acme', tier: 'universe', accepted: true, children: [] }),
    ]), urlFor)).toBe('host-of:acme');
  });

  it("one ACCEPTED Universe holding exactly one app skips Home into that app's Studio", () => {
    // A signup writes the account and its first app, so this is the common day-one shape: the one
    // place to work is the app. Reds against stopping at the universe page.
    expect(fastForwardTarget(summary([
      node({ scope: 'acme', tier: 'universe', accepted: true, children: [node({ scope: 'acme.crm', tier: 'galaxy' })] }),
    ]), urlFor)).toBe('host-of:acme.crm');
  });

  it('a Universe with two apps, or more than the level shows, goes to its page to choose', () => {
    expect(fastForwardTarget(summary([node({
      scope: 'acme', tier: 'universe', accepted: true,
      children: [node({ scope: 'acme.crm', tier: 'galaxy' }), node({ scope: 'acme.web', tier: 'galaxy' })],
    })]), urlFor)).toBe('host-of:acme');
    // One app listed of three the frontier counts: the person has a choice the level does not show.
    expect(fastForwardTarget(summary([node({
      scope: 'acme', tier: 'universe', accepted: true, childCount: 3, children: [node({ scope: 'acme.crm', tier: 'galaxy' })],
    })]), urlFor)).toBe('host-of:acme');
  });

  it('one accepted GALAXY skips Home to its Studio', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'acme.crm', tier: 'galaxy', accepted: true }),
    ]), urlFor)).toBe('host-of:acme.crm');
  });

  it('a lone accepted PLATFORM membership stays on Home — it has no surface', () => {
    // The superuser. Reds against fast-forwarding a surfaceless membership, which would send them to
    // `/_platform`. Home renders instead, with the platform row unclickable.
    expect(fastForwardTarget(summary([
      node({ scope: PLATFORM_SCOPE, tier: 'universe', accepted: true }),
    ]), urlFor)).toBeUndefined();
  });

  it('two memberships never skip Home, even when both are accepted Stars', () => {
    expect(fastForwardTarget(summary([
      node({ scope: 'a.b.c', tier: 'star', accepted: true }),
      node({ scope: 'd.e.f', tier: 'star', accepted: true }),
    ]), urlFor)).toBeUndefined();
  });

  it('memberships spread across two ADDRESSES are still two memberships', () => {
    // Reds against counting per-section instead of per-person — the summary is `profileId`-keyed,
    // so someone with one Star on each of two addresses has a choice to make.
    expect(fastForwardTarget({
      emails: [
        { email: 'a@example.com', memberships: [node({ scope: 'a.b.c', tier: 'star', accepted: true })] },
        { email: 'b@example.com', memberships: [node({ scope: 'd.e.f', tier: 'star', accepted: true })] },
      ],
    }, urlFor)).toBeUndefined();
  });
});

describe('where Home goes after an Accept', () => {
  const home = (groups: ScopeNode[][], pending: string[] = []): HomeSummary => ({
    groups: groups.map((memberships, i) => ({ profileId: `p${i}`, summary: { emails: [{ email: `${i}@example.com`, memberships }] } })),
    pending, held: [],
  });
  const account = node({ scope: 'acme', tier: 'universe', accepted: true, children: [node({ scope: 'acme.crm', tier: 'galaxy' })] });

  it("a ticket-backed signup's Accept goes into its new app, as a fresh visit would", () => {
    // The re-read summary holds the account and its first app, so the move is the lone-app
    // fast-forward, whose host is the one still waiting for its certificate.
    expect(afterAcceptTarget(home([[account]]), node({ scope: 'acme', tier: 'universe' }), urlFor)).toBe('host-of:acme.crm');
  });

  it("with a choice still to make, the accepted row's own page", () => {
    const other = node({ scope: 'globex', tier: 'universe', accepted: true, children: [] });
    expect(afterAcceptTarget(home([[account], [other]]), node({ scope: 'acme', tier: 'universe' }), urlFor)).toBe('host-of:acme');
    expect(homeFastForward(home([[account]], ['initech']), urlFor)).toBeUndefined();
  });
});

describe('which rows need a fresh login', () => {
  // A row's host mints from that membership's own cookie, or from an admin cookie at or above it —
  // the refresh's own pick. `held` is what Home's summary read: the scope and admin bit of every
  // cookie whose record was live.
  const row = (scope: string) => node({ scope, tier: scope.split('.').length === 1 ? 'universe' : 'star', accepted: true });

  it("a row whose own cookie is held needs none", () => {
    expect(needsFreshLogin(row('acme.crm.t1'), [{ scope: 'acme.crm.t1', scopeAdmin: false }])).toBe(false);
  });

  it('a row beneath a held ADMIN cookie needs none — that cookie mints on its host', () => {
    expect(needsFreshLogin(row('acme.crm.t1'), [{ scope: 'acme', scopeAdmin: true }])).toBe(false);
    expect(needsFreshLogin(row('acme.crm.t1'), [{ scope: PLATFORM_SCOPE, scopeAdmin: true }])).toBe(false);
  });

  it('a row beneath only a held PLAIN cookie needs one — a plain membership mints on its own host alone', () => {
    // Reds against covering by containment alone, which would send the person to a 401.
    expect(needsFreshLogin(row('acme.crm.t1'), [{ scope: 'acme', scopeAdmin: false }])).toBe(true);
  });

  it('a row no held cookie reaches needs one, and containment is by whole segments', () => {
    expect(needsFreshLogin(row('acme.crm.t1'), [])).toBe(true);
    // `acme` must not cover `acme-2` — the naive `startsWith` gets this wrong.
    expect(needsFreshLogin(row('acme-2.crm.t1'), [{ scope: 'acme', scopeAdmin: true }])).toBe(true);
  });
});

describe("which rows link to their account's page for adding an app and deleting the account", () => {
  // Home performs neither; the account's own page does both, and only for its accepted admin.
  it("an accepted admin's account offers both", () => {
    expect(offersAccountActions(node({ scope: 'acme', tier: 'universe', scopeAdmin: true, accepted: true }))).toBe(true);
  });

  it("a plain member's, an unaccepted, an app's or the platform's row offers neither", () => {
    expect(offersAccountActions(node({ scope: 'acme', tier: 'universe', scopeAdmin: false, accepted: true }))).toBe(false);
    expect(offersAccountActions(node({ scope: 'acme', tier: 'universe', scopeAdmin: true, accepted: false }))).toBe(false);
    expect(offersAccountActions(node({ scope: 'acme.crm', tier: 'galaxy', scopeAdmin: true, accepted: true }))).toBe(false);
    expect(offersAccountActions(node({ scope: PLATFORM_SCOPE, tier: 'universe', scopeAdmin: true, accepted: true }))).toBe(false);
  });
});

describe("which app rows link to the app's Studio for its delete", () => {
  const account = node({ scope: 'acme', tier: 'universe', scopeAdmin: true, accepted: true });

  it("an app beneath its account's accepted admin, or held as an accepted admin, offers it", () => {
    expect(offersAppDelete(node({ scope: 'acme.crm', tier: 'galaxy' }), account)).toBe(true);
    expect(offersAppDelete(node({ scope: 'acme.crm', tier: 'galaxy', scopeAdmin: true, accepted: true }))).toBe(true);
  });

  it("a plain or unaccepted app membership, an app beneath a plain account, or a tenant offers none", () => {
    expect(offersAppDelete(node({ scope: 'acme.crm', tier: 'galaxy', scopeAdmin: false, accepted: true }))).toBe(false);
    expect(offersAppDelete(node({ scope: 'acme.crm', tier: 'galaxy', scopeAdmin: true, accepted: false }))).toBe(false);
    expect(offersAppDelete(node({ scope: 'acme.crm', tier: 'galaxy' }),
      node({ scope: 'acme', tier: 'universe', scopeAdmin: false, accepted: true }))).toBe(false);
    expect(offersAppDelete(node({ scope: 'acme.crm.t1', tier: 'star' }), account)).toBe(false);
  });
});

describe('which pending membership a login page offers instead of the form', () => {
  // A person who signed in without accepting an invite, then visited its host, arrives at the
  // login with `return_to` naming that host. Offering the login would bring them back to the same
  // 401; `invites-land-on-their-host` drives it live.
  it('the pending membership at the return host is offered', () => {
    expect(pendingFor(['acme.crm', 'other.web'], 'acme.crm')).toBe('acme.crm');
  });

  it('a pending membership elsewhere, or no return host at all, offers nothing', () => {
    expect(pendingFor(['other.web'], 'acme.crm')).toBeUndefined();
    expect(pendingFor(['acme.crm'], undefined)).toBeUndefined();
  });
});
