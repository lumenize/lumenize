/**
 * DevStudio resource data-plane — real-NebulaClient e2e (Child 1, nebula-devstudio-data-plane.md Phase 5).
 *
 * A `NebulaClient` configured `resourceHostBinding: 'DEV_STUDIO'` (D9) hosts the
 * chat `Session`/`Turn` Resources on the **DevStudio** DO instead of a Star —
 * exercised through the **public** API (`client.resources.*` / `client.orgTree.*`)
 * over the full integration path (real JWTs minted locally + verified normally —
 * NOT a test-mode bypass), proving the Phase-3-deferred criteria that need a
 * Gateway + client:
 *   - CRUD + the ADR-006 `Turn.session` FK in one atomic transaction (client UUIDs);
 *   - single-resource subscribe + fanout PUSH to a *second* subscriber client;
 *   - DAG permission: a non-granted subject is denied, a granted one allowed (SC2);
 *   - the snapshot's `ontologyVersion` is server-sourced regardless of the client's
 *     `appVersion`, and a "wrong" appVersion does NOT error (D8 no-version-gate + m4).
 *
 * DevStudio needs no ontology-apply: its Session/Turn ontology is the fixed
 * platform constant compiled on-DO. No Galaxy round-trip.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID, SESSION_TURN_ONTOLOGY_VERSION } from '@lumenize/nebula';
import type { Snapshot } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

// A DevStudio sandbox is the `{u}.{g}.dev` star-tier instance.
const uniqueDevScope = () => `acme-${generateUuid().slice(0, 8)}.app.dev`;

// Admin (scope-admin) client bound to DEV_STUDIO. appVersion is irrelevant to
// DevStudio (no version-gate, D8) — default 'v1'.
function devAdmin(scope: string, appVersion = 'v1') {
  return createAuthenticatedClient(
    NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', appVersion,
    { resourceHostBinding: 'DEV_STUDIO' },
  );
}

describe('DevStudio resources e2e (real NebulaClient, resourceHostBinding: DEV_STUDIO)', () => {
  it('creates a Session + Turn (FK, client UUIDs) in one transaction; reads them back; version is server-stamped', async () => {
    const scope = uniqueDevScope();
    // Deliberately "wrong" appVersion: DevStudio must ignore it (no stale error, D8)
    // and stamp the server constant (m4).
    const { client } = await devAdmin(scope, 'client-claims-WRONG');
    const sessionId = generateUuid();
    const turnId = generateUuid();

    const out = await client.resources.transaction({
      [sessionId]: { op: 'create', typeName: 'Session', nodeId: ROOT_NODE_ID, value: { title: 'chat 1' } },
      [turnId]: { op: 'create', typeName: 'Turn', nodeId: ROOT_NODE_ID, value: { session: sessionId, role: 'user', content: 'hello' } },
    });
    expect(out.kind).toBe('committed');

    const turn = await client.resources.read('Turn', turnId) as Snapshot;
    expect((turn.value as { session: string }).session).toBe(sessionId); // ADR-006 by-id FK
    expect((turn.value as { content: string }).content).toBe('hello');
    // m4: stamped with the SERVER constant, NOT the client's bogus appVersion.
    expect(turn.meta.ontologyVersion).toBe(SESSION_TURN_ONTOLOGY_VERSION);
    expect(turn.meta.ontologyVersion).not.toBe('client-claims-WRONG');

    const session = await client.resources.read('Session', sessionId) as Snapshot;
    expect((session.value as { title: string }).title).toBe('chat 1');

    client[Symbol.dispose]();
  });

  it('fans a Turn mutation out to a SECOND subscriber client (push to other subscribers)', async () => {
    const scope = uniqueDevScope();
    const { client: a } = await devAdmin(scope);
    // Distinct Browser ⇒ distinct Gateway ⇒ distinct clientId (the fanout is keyed
    // on clientId, so b's put fans out to a, the non-originator subscriber).
    const { client: b } = await devAdmin(scope);
    const turnId = generateUuid();

    using sub = a.resources.createAndSubscribe('Turn', turnId, ROOT_NODE_ID, { session: 'sess-x', role: 'user', content: 'v1' });
    const created = await sub.snapshot;
    expect(created).not.toBeNull();
    const eTag = created!.meta.eTag;

    const baseline = a.resourceUpdateCount;
    const out = await b.resources.transaction({
      [turnId]: { op: 'put', typeName: 'Turn', eTag, value: { session: 'sess-x', role: 'assistant', content: 'v2-from-b' } },
    });
    expect(out.kind).toBe('committed');

    // a (the OTHER subscriber) receives b's mutation via fanout.
    await vi.waitFor(() => {
      expect(a.resourceUpdateCount).toBeGreaterThan(baseline);
      expect((a.lastResourceUpdate?.snapshot?.value as { content?: string } | undefined)?.content).toBe('v2-from-b');
    });

    a[Symbol.dispose]();
    b[Symbol.dispose]();
  });

  it('DAG permission: a non-granted subject is denied; granting write lets them in (SC2)', async () => {
    const scope = uniqueDevScope();
    const { client: admin, accessToken } = await devAdmin(scope);

    // Admin (scope-admin bypass) makes a private node + a Turn on it.
    const nodeId = await admin.orgTree.createNode(ROOT_NODE_ID, 'private', 'Private');
    const existingTurn = generateUuid();
    const seed = await admin.resources.transaction({
      [existingTurn]: { op: 'create', typeName: 'Turn', nodeId, value: { session: 'sess-x', role: 'user', content: 'secret' } },
    });
    expect(seed.kind).toBe('committed');

    // A non-admin subject at the same {u}.{g}.dev scope (real signup; no grant yet).
    const adminBrowser = new Browser();
    await browserLogin(adminBrowser, scope, 'admin@example.com', scope);
    await createSubject(adminBrowser, scope, accessToken, 'coach@example.com');
    const { client: user, payload } = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), scope, scope, 'coach@example.com', 'v1',
      { resourceHostBinding: 'DEV_STUDIO' },
    );

    // DENIED: read the existing Turn (exists but no grant) → rejects with permission.
    await expect(user.resources.read('Turn', existingTurn)).rejects.toThrow(/permission/i);
    // DENIED: write a new Turn on the node → per-resource permission-denied.
    const denied = await user.resources.transaction({
      [generateUuid()]: { op: 'create', typeName: 'Turn', nodeId, value: { session: 'sess-x', role: 'user', content: 'nope' } },
    });
    expect(denied.kind).toBe('rejected');
    expect(denied.kind === 'rejected' && denied.resources[Object.keys(denied.resources)[0]]?.kind).toBe('permission-denied');

    // GRANT write to the user, then they CAN create + read on the node.
    await admin.orgTree.setPermission(nodeId, payload.sub, 'write');
    const myTurn = generateUuid();
    const allowed = await user.resources.transaction({
      [myTurn]: { op: 'create', typeName: 'Turn', nodeId, value: { session: 'sess-x', role: 'user', content: 'mine' } },
    });
    expect(allowed.kind).toBe('committed');
    const back = await user.resources.read('Turn', myTurn) as Snapshot;
    expect((back.value as { content: string }).content).toBe('mine');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });
});
