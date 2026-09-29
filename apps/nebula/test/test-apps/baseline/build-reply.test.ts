/**
 * The build reply — a build is somebody's request, so the Galaxy that ran it answers
 * whoever asked, and nobody else.
 *
 * A successful build tells the requesting client its preview is ready
 * (`Galaxy.announceBuildToRequester` → the client's `handlePreviewReady`), once per build.
 * Nothing subscribes to it: the answer follows the request, addressed by the `instanceName`
 * already on the call that started the turn.
 *
 *  - T1: a chat turn whose `build` tool succeeds replies exactly once to the client that
 *        asked, and a turn with no build call replies nothing.
 *  - T3: the reply goes to the REQUESTER ONLY — a second participant connected to the same
 *        Galaxy is deliberately not told.
 *
 * ⓘ The Star's reload channel, which T2 covered, is gone, and nothing subscribes to a reload
 * any more. T2 asserted that a reload subscriber survived `resetDevData`'s wipe, which has no
 * meaning without one.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { universeAdminClient, uniqueGalaxyScope } from '../../test-helpers';
import { NebulaClientTest } from './index';

/** One fake model round that calls the build tool, then one that marks complete. */
const BUILD_THEN_COMPLETE = [
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'b1', type: 'function', function: { name: 'build', arguments: '{}' } },
  ] } }] },
  { choices: [{ message: { content: '', reasoning_content: '', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'mark_complete', arguments: '{}' } },
  ] } }] },
];
/** A text-only script — the turn completes with NO build call (no reply may fire). */
const NO_BUILD = [
  { choices: [{ message: { content: 'just chatting', reasoning_content: '', tool_calls: [] } }] },
];

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
}
async function devAdminClient(galaxy: string, dev: string, extraConfig?: Record<string, unknown>) {
  return universeAdminClient(NebulaClientTest, new Browser(), galaxy, dev, 'admin@example.com', 'v1', extraConfig);
}
describe('The build reply', () => {
  it('T1: a successful build REPLIES to the requester, and a turn with no build replies nothing', async () => {
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client } = await devAdminClient(galaxy, dev);

    // A chat turn whose build succeeds replies exactly once, to the client that asked. No
    // subscription is involved — this client never enrolled anywhere for it, which is the
    // point: the answer follows the request.
    const beforeBuild = client.previewReadyCount;
    client.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => { expect(client.previewReadyCount).toBe(beforeBuild + 1); }, { timeout: 15000 });

    // A turn with NO build call replies nothing (the trigger is build completion, not
    // turn completion).
    const beforeChat = client.previewReadyCount;
    client.callGalaxyChatScripted(galaxy, 'just talk', NO_BUILD);
    await waitForResult(client);
    expect(client.previewReadyCount).toBe(beforeChat);

    client[Symbol.dispose]();
  });

  it('T3: the build reply goes to the REQUESTER ONLY — a second participant is deliberately not told', async () => {
    // The design property, asserted directly: a build is somebody's request, so the
    // answer goes to them. A bystander in the same chat keeps the older UI until their
    // own lazy path catches up — a staleness cost accepted on purpose, since unchanged
    // ontology leaves old code data-correct. ⚠️ This is what a fan-out would blur: with
    // a broadcast BOTH clients tick, so this test is the one that distinguishes the two
    // designs and it reds if a fan-out is ever restored.
    const { galaxy, dev } = uniqueGalaxyScope();
    const { client: requester } = await devAdminClient(galaxy, dev, {
      chatHostBinding: 'GALAXY', chatScope: galaxy,
    });
    const { client: bystander } = await devAdminClient(galaxy, dev, {
      chatHostBinding: 'GALAXY', chatScope: galaxy,
    });

    const r0 = requester.previewReadyCount, b0 = bystander.previewReadyCount;
    requester.callGalaxyChatScripted(galaxy, 'build it', BUILD_THEN_COMPLETE);
    await vi.waitFor(() => { expect(requester.previewReadyCount).toBe(r0 + 1); }, { timeout: 15000 });
    // The bystander is connected to the same Galaxy on the same chat pair and still
    // gets nothing — so the reply is addressed, not fanned.
    expect(bystander.previewReadyCount).toBe(b0);

    requester[Symbol.dispose](); bystander[Symbol.dispose]();
  });
});
