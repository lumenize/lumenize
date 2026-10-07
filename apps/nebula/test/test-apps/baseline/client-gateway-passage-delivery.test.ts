/**
 * Passage decides what reaches a tab, through a real host node: a Galaxy reaches a plain member's
 * tab on one of its Stars, and a sibling Star is refused at the Star hosting the tab, by message.
 * The tab connects at `/gateway/{id}` on its Star's host, so the Star holds its socket as
 * `{star}/{id}`, and every push to it arrives at the Star's own doors.
 *
 * In-lane rather than `/live`, because no production path makes one Star push to another Star's
 * member, so the lateral refusal is reachable only through the test subclasses' `callClientReporting`,
 * which keeps a refusal so it can be matched by message. A Galaxy's push to a hosted tab is driven
 * live by `scope-hosts-its-clients`. The tab's holder is a plain member of their Star, whose token's `aud` is that
 * Star's host, so passage reaches up to the Galaxy and never across to a sibling.
 * A Profile push reaching a tab in another universe is `profile-subscribe.test.ts`'s HEADLINE, and
 * every kind of fresh-chain update arriving is `update-identity.test.ts`'s.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import { universeAdminClient, createSubject, createInvitedClient, uniqueGalaxyScope, addressOfClient } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { StarTest, GalaxyTest } from './index';

describe('passage decides what reaches a tab', () => {
  it('a Galaxy reaches a plain member\'s tab on its Star, a sibling Star is refused, and a fresh-chain update arrives', async () => {
    const { galaxy, starA, starB } = uniqueGalaxyScope();
    // On the galaxy's page: the admin drives the Galaxy and both Stars beneath it, and dominion
    // runs down from the page (the host rule).
    const { client: admin, accessToken } = await universeAdminClient(
      NebulaClientTest, new Browser(), starA, galaxy, 'admin@example.com');
    await createSubject(new Browser(), starA, accessToken, 'member@example.com');
    const { client: member, payload } = await createInvitedClient(
      NebulaClientTest, new Browser(), starA, starA, 'member@example.com');
    expect(payload.access).toEqual({ authScope: starA }); // fixture guard: a plain member of Star A
    const tab = addressOfClient(member);

    // The Galaxy above the tab's Star: upward, so the tab has passage into the sender.
    const before = member.orgTreeUpdateCount;
    await admin.lmz.callAsync('GALAXY', galaxy,
      admin.ctn<GalaxyTest>().callClientReporting(tab, 'handleOrgTreeUpdate', { value: {} }));
    await vi.waitFor(() => expect(member.orgTreeUpdateCount).toBe(before + 1));
    expect(await admin.lmz.callAsync('GALAXY', galaxy, admin.ctn<GalaxyTest>().clientCallOutcome()))
      .toBeUndefined(); // no refusal came back

    // A sibling Star: lateral, refused at the Star hosting the tab with the passage message, which
    // that Star fires back to the sender's handler after its ack.
    await admin.lmz.callAsync('STAR', starB,
      admin.ctn<StarTest>().callClientReporting(tab, 'handleOrgTreeUpdate', { value: {} }));
    await vi.waitFor(async () => expect(await admin.lmz.callAsync('STAR', starB,
      admin.ctn<StarTest>().clientCallOutcome())).toBe(`No passage from "${starA}" into "${starB}"`));
    expect(member.orgTreeUpdateCount).toBe(before + 1);

    // A subscription update starts a fresh chain and carries no claims, and still arrives.
    // Through `callAsync`, since the test initiator's `resetResults()` would zero the count.
    await member.lmz.callAsync('STAR', starA, member.ctn<StarTest>().resources.subscribeTree());
    await vi.waitFor(() => expect(member.orgTreeUpdateCount).toBe(before + 2)); // the initial tree
    // Star A's tree, which the tab watches — the admin's page is the galaxy's, so it names the Star.
    await admin.lmz.callAsync('STAR', starA,
      admin.ctn<StarTest>().resources.orgTree.createNode(crypto.randomUUID(), ROOT_NODE_ID, 'pushed', 'Pushed'));
    await vi.waitFor(() => expect(member.orgTreeUpdateCount).toBe(before + 3));
    const update = member.pushOrigins.filter((p) => p.handler === 'handleOrgTreeUpdate').at(-1)!;
    expect(update).toEqual({ handler: 'handleOrgTreeUpdate', originSub: undefined, chain: ['STAR'] });

    admin[Symbol.dispose]();
    member[Symbol.dispose]();
  });
});
