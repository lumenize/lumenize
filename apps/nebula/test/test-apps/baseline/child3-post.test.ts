/**
 * Child 3 Phase 4 — client posts the user Message (D3 / D-human-no-stream / D-echo).
 *
 * `NebulaClient.postUserMessage` (the create half of `chat`, split out because the full
 * `chat` also fires the wrangler-dev-only codegen kick) writes ONE atomic `role:'user'`
 * Message stamped with the sender's `author`. It rides the session query, so the sender
 * AND a second subscriber both see it via the fanout — the sender does NOT optimistically
 * echo (D-echo default: wait for the rerun). A user message is never streamed
 * (D-human-no-stream): no `handleStreamChunk` fires for it.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { DEFAULT_SESSION_ID, SESSION_NODE_ID } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { universeAdminClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueDevScope = () => `c3p-${generateUuid().slice(0, 8)}.app.dev`;
const sessionQuery = {
  queryType: 'parentChild' as const, typeName: 'Message', field: 'session', value: DEFAULT_SESSION_ID,
};

  // ⚠️ `universeAdminClient`, not `adminClientAt`: a `{u}.{g}.dev` star is FOUNDERLESS by
  // construction — `create-star` mints no founder and `claim-star` refuses the reserved slug — so it
  // is administered by the covering admin's wildcard. That is how it works in production, not a test
  // concession. (`adminClientAt` refuses this scope outright for exactly that reason.)
function devClient(scope: string, email = 'admin@example.com') {
  return universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, email, 'v1',
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

describe('child3 Phase 4 — client posts the user Message', () => {
  it('sender and a 2nd subscriber both see posted user Messages in send order; no streaming for a user message', async () => {
    const scope = uniqueDevScope();
    const { client: sender, payload: senderPayload } = await devClient(scope);
    const { client: observer } = await devClient(scope); // distinct participant (same admin email, different client)

    using ss = sender.resources.subscribeQuery(sessionQuery); await ss.ready;
    using so = observer.resources.subscribeQuery(sessionQuery); await so.ready;
    expect(ss.resourceIds).toEqual([]);

    // Sender posts m1, then observer posts m2 (separate transactions, advancing clock →
    // distinct validFrom → chronological order).
    const m1 = await sender.postUserMessage('hello from sender');
    await vi.waitFor(() => expect(ss.resourceIds).toContain(m1));   // sender sees its OWN via the fanout (no echo)
    await vi.waitFor(() => expect(so.resourceIds).toContain(m1));   // observer sees it too

    const m2 = await observer.postUserMessage('hi from observer');
    // Both clients converge on the same ordered membership [m1, m2].
    await vi.waitFor(() => expect(ss.resourceIds).toEqual([m1, m2]));
    await vi.waitFor(() => expect(so.resourceIds).toEqual([m1, m2]));

    // The observer reads m1's content: role/author/node stamped correctly.
    const snap = await observer.resources.read('Message', m1) as Snapshot;
    const v = snap.value as { role?: string; content?: string; author?: string };
    expect(v.role).toBe('user');
    expect(v.content).toBe('hello from sender');
    // `author` is `claims.sub` (nebula-client.ts `postUserMessage`), and since the surrogate-`sub`
    // change that is a random opaque id, NOT the email. Assert against the sender's actual `sub`
    // rather than a literal — a hardcoded email here only ever passed under the pre-surrogate model.
    expect(v.author).toBe(senderPayload.sub);             // sender's sub (display-only)
    expect(v.author).not.toContain('@');                  // guard: never re-anchor this on an email
    expect(snap.meta.nodeId).toBe(SESSION_NODE_ID);

    // D-human-no-stream: posting a user Message streams NOTHING (a single atomic create,
    // not the assistant progress path). Capable-of-failing: wiring a stream into the post
    // would make these non-zero.
    expect(sender.streamChunkCount).toBe(0);
    expect(observer.streamChunkCount).toBe(0);

    sender[Symbol.dispose](); observer[Symbol.dispose]();
  });
});
