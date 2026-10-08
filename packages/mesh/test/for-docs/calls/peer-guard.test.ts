/**
 * LumenizeClient default peer-guard (tasks/mesh-client-peer-guard.md).
 *
 * The client's default `onBeforeCall` blocks a DIRECT client→client call by checking the IMMEDIATE
 * caller (`callChain.at(-1)`), NOT the origin. This is the foundation-default proof, homed in
 * `@lumenize/mesh`'s own package on a host node whose `onBeforeCallToClient` checks passage into the
 * sender only, which a Client sender skips, so the CLIENT guard is the sole rejecter. Every user logs
 * in on one workspace's page through Mesh's Registry (ADR-009 rung 2). `EditorClient` carries NO
 * `onBeforeCall` override → it exercises the DEFAULT guard.
 *
 * Every test is capable-of-failing; the mutation-checks below were RUN and observed to flip during the
 * build (tasks/mesh-client-peer-guard.md § Success criteria).
 */
import { it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { EditorClient } from './editor-client.js';
import { loginAt, uniqueScope, type Login } from '../../support/login.js';
import type { DocumentDO } from './document-do.js';
import type { SpellFinding } from './spell-check-worker.js';

/** A connected `EditorClient` with the DEFAULT peer-guard, logged in as `login`. */
async function connectEditor(login: Login): Promise<EditorClient> {
  const browser = new Browser();
  const client = new EditorClient({
    instanceName: `${login.sub}.tab1`,
    baseUrl: login.baseUrl,
    refresh: login.refresh,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
  });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });
  return client;
}

it('#1 default guard ACCEPTS a DO-mediated cross-client fanout push (caller = the DO)', async () => {
  const workspace = uniqueScope('acme');
  const writerLogin = await loginAt(workspace);
  const receiverLogin = await loginAt(workspace);
  using writer = await connectEditor(writerLogin);
  using receiver = await connectEditor(receiverLogin);
  const documentId = crypto.randomUUID();
  await writer.createDocument(documentId);
  await writer.shareDocument(documentId, receiverLogin.sub);

  // Receiver subscribes with the DEFAULT guard (no override). Capture pushed content + the immediate
  // caller type the receiver sees on each `handleContentUpdate`.
  const contents: string[] = [];
  const callerTypes: (string | undefined)[] = [];
  receiver.openDocument(documentId, {
    onContentUpdate: (c) => contents.push(c),
    onContentUpdateContext: (ctx) => callerTypes.push(ctx.callChain.at(-1)?.type),
  });
  await vi.waitFor(() => expect(contents[0]).toBe(''), { timeout: 10000 }); // subscribe landed (initial snapshot)

  // Writer (a DIFFERENT client) mutates via the origin-PRESERVING fanout (no newChain), so the
  // receiver sees callChain = [writerClient, DocumentDO] → at(-1) is the DO.
  writer.lmz.call('DOCUMENT_DO', documentId,
    writer.ctn<DocumentDO>().updatePreservingOrigin('hello from writer'),
    writer.ctn().handleCallFailed('update'), { onErrorOnly: true });

  await vi.waitFor(() => expect(contents).toContain('hello from writer'), { timeout: 10000 });
  // Accepted BECAUSE the immediate caller is the DO, even though the ORIGIN is another client.
  // MUTATION-CHECK (run + observed to flip): revert onBeforeCall to `callChain[0]` and this reds —
  // the origin is the writer client, so the old origin-based guard rejects this cross-client push.
  expect(callerTypes).toContain('LumenizeDO');
}, 20000);

it('#2 default guard BLOCKS a direct client→client call (caller = a client), via their host', async () => {
  const workspace = uniqueScope('acme');
  const aliceLogin = await loginAt(workspace);
  const bobLogin = await loginAt(workspace);
  using alice = await connectEditor(aliceLogin);
  using bob = await connectEditor(bobLogin);
  const documentId = crypto.randomUUID();
  await bob.createDocument(documentId);
  await bob.shareDocument(documentId, aliceLogin.sub);

  const bobContents: string[] = [];
  bob.openDocument(documentId, { onContentUpdate: (c) => bobContents.push(c) });
  await vi.waitFor(() => expect(bobContents[0]).toBe(''), { timeout: 10000 }); // bob subscribed

  // Alice calls bob's @mesh `handleContentUpdate` DIRECTLY through their host (no DO in the chain).
  // bob sees callChain = [alice]; at(-1) = alice (a LumenizeClient, DISTINCT instanceName) → bob's
  // default guard REJECTS it before `handleContentUpdate` runs.
  alice.lmz.call('WORKSPACE_DO', `${workspace}/${bob.lmz.instanceName}`,
    alice.ctn<EditorClient>().handleContentUpdate(documentId, 'DIRECT-FROM-ALICE'),
    alice.ctn().handleCallFailed('direct push'), { onErrorOnly: true });

  // Same-connection BARRIER (testing.md § never setTimeout): a legit DO-mediated push that IS
  // delivered. Once THIS lands on bob, the earlier direct call would have landed too if allowed.
  alice.lmz.call('DOCUMENT_DO', documentId,
    alice.ctn<DocumentDO>().updatePreservingOrigin('VIA-DO'),
    alice.ctn().handleCallFailed('update'), { onErrorOnly: true });
  await vi.waitFor(() => expect(bobContents).toContain('VIA-DO'), { timeout: 10000 });

  // The direct client→client push was rejected by bob's default guard and never delivered.
  // CAPABLE-OF-FAILING (run + observed to flip): remove the guard entirely and 'DIRECT-FROM-ALICE' arrives.
  expect(bobContents).not.toContain('DIRECT-FROM-ALICE');
}, 20000);

it('#3 default guard ACCEPTS a Worker-mediated push (caller = a LumenizeWorker) — no DO-only regression', async () => {
  using client = await connectEditor(await loginAt(uniqueScope('acme')));
  const documentId = crypto.randomUUID();
  await client.createDocument(documentId);

  const findings: SpellFinding[][] = [];
  const doc = client.openDocument(documentId, { onSpellFindings: (f) => findings.push(f) });
  await vi.waitFor(() => expect(client.connectionState).toBe('connected'), { timeout: 10000 });

  // Writing "teh" triggers DocumentDO → SpellCheckWorker, which DIRECT-DELIVERS handleSpellFindings
  // back to this client. The client sees callChain.at(-1) = the SpellCheckWorker (a LumenizeWorker),
  // which the default guard must accept.
  doc.saveContent('teh quick brown fox');

  await vi.waitFor(() => expect(findings.length).toBeGreaterThan(0), { timeout: 10000 });
  expect(findings[0][0].word).toBe('teh');
  // MUTATION-CHECK (run + observed to flip): a DO-only-allow guard (`caller.type !== 'LumenizeDO'`)
  // would reject this Worker push → `findings` stays empty. The correct caller-based guard accepts it.
}, 20000);
