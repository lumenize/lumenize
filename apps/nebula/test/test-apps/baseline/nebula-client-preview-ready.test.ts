/**
 * The preview refresh hook — driven by its ONE surviving producer, the build reply.
 *
 * A build a client asked for is answered to that client: `Galaxy.announceBuildToRequester`
 * → direct delivery of `handlePreviewReady(scope)` by the client's stable `instanceName` →
 * the client invokes the `onPreviewReady` hook, and the Studio reloads the iframe. The
 * former initial-load cue (`warmPreview`) was deleted when the source entries moved to the
 * chat floor (`.claude/rules/security.md`)
 * — `dist/` serves from the Galaxy's own VFS, so there was nothing to warm — and the echo
 * stand-in that used to drive this file went with it. What remains to assert is the hook
 * half: that the reply's scope reaches the application-level hook, which
 * `build-reply.test.ts` T1 counts on the client subclass but never observes as
 * the hook a UI would install.
 *
 * Mutation-validated (testing.md): commenting out `this.#onPreviewReady?.(scope)` in
 * `NebulaClient.handlePreviewReady` leaves `captured` empty → the `vi.waitFor` times
 * out → this test reddens. Removing the `announceBuildToRequester` call from
 * `#buildAndAnnounce` reds it the same way.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID } from '@lumenize/nebula';
import { universeAdminClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';
import type { GalaxyTest } from './index';

/** One fake model round that calls the build tool, then one that marks complete. */
const BUILD_THEN_COMPLETE = [
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
  ] } }] },
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
  ] } }] },
];

describe('nebula-client preview-ready hook — the build reply', () => {
  it('a turn whose build succeeds invokes onPreviewReady with the Galaxy scope, on the client that asked', async () => {
    const { galaxy } = uniqueGalaxyScope();
    const captured: string[] = [];
    // On Studio's page, the galaxy's own, where a chat turn is asked for.
    const { client } = await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, galaxy, 'admin@example.com', 'v1',
      { onPreviewReady: (scope: string) => { captured.push(scope); } },
    );

    // Positive control for the wait below: nothing has fired yet.
    expect(captured).toEqual([]);
    client.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);

    // The reply is addressed to THIS client and carries the Galaxy's own scope — the
    // Studio compares it against its active scope before reloading.
    await vi.waitFor(() => { expect(captured).toContain(galaxy); }, { timeout: 15000 });
    expect(captured).toHaveLength(1);

    client[Symbol.dispose]();
  });

  // The nudge stays point-to-point and starts a fresh chain, like every push. Mutations: fan the
  // nudge out to the chat's subscribers, and the second client counts one too; send it without
  // `newChain`, and its frame carries the asking client's claims.
  it('only the client that asked is nudged, and the nudge carries none of its claims', async () => {
    const { galaxy } = uniqueGalaxyScope();
    const chatPair = { resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: galaxy } as const;
    const { client: asker } = await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, galaxy, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    const { client: other } = await universeAdminClient(
      NebulaClientTest, new Browser(), galaxy, galaxy, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, chatPair);
    expect(other.lmz.instanceName).not.toBe(asker.lmz.instanceName); // fixture guard: two tabs

    // The other tab watches the chat, as a second Studio does, so it is on every list a fanout reads.
    using chat = other.resources.subscribeQuery(
      { queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID });
    await chat.ready;

    asker.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => expect(asker.previewReadyCount).toBe(1), { timeout: 15000 });

    // Barrier: a directed call from the same Galaxy to the other tab, sent after the asker's nudge
    // landed, so a nudge the Galaxy had sent that tab is in before it.
    const trees = other.orgTreeUpdateCount;
    await asker.lmz.callAsync('GALAXY', galaxy,
      asker.ctn<GalaxyTest>().callClientReporting(other.lmz.instanceName!, 'handleOrgTreeUpdate', { value: {} }));
    await vi.waitFor(() => expect(other.orgTreeUpdateCount).toBe(trees + 1));
    expect(other.previewReadyCount).toBe(0);
    expect(asker.pushOrigins.filter((p) => p.handler === 'handlePreviewReady'))
      .toEqual([{ handler: 'handlePreviewReady', originSub: undefined, chain: ['GALAXY'] }]);

    asker[Symbol.dispose]();
    other[Symbol.dispose]();
  });
});
