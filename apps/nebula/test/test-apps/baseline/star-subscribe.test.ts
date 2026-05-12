/**
 * Star subscribe machinery — Phase 5.3.1
 *
 * Tests `@mesh() subscribe()` on Star, the Subscriptions class's idempotent
 * row insertion, and error-as-data delivery through `handleResourceUpdate`.
 * Fanout on mutation (Phase 5.3.2) is NOT covered here.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { Snapshot, TransactionResult, SubscriberRow } from '@lumenize/nebula';
import { createAuthenticatedClient, browserLogin, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function adminClient(star: string) {
  const browser = new Browser();
  const result = await createAuthenticatedClient(NebulaClientTest, browser, star, star, 'admin@example.com');

  const galaxyName = star.split('.').slice(0, 2).join('.');
  result.client.callGalaxyAppendOntologyVersion(galaxyName, {
    version: ONTOLOGY_VERSION,
    types: TEST_TYPES,
  });
  await waitForResult(result.client);

  return result;
}

async function userClient(star: string, adminToken: string, email = 'user@example.com') {
  const adminBrowser = new Browser();
  const { accessToken } = await browserLogin(adminBrowser, star, 'admin@example.com', star);
  const userBrowser = new Browser();
  await createSubject(adminBrowser, star, accessToken, email);
  return createAuthenticatedClient(NebulaClientTest, userBrowser, star, star, email);
}

async function waitForResult(client: NebulaClientTest) {
  await vi.waitFor(() => {
    expect(client.callCompleted).toBe(true);
  });
}

async function waitForSuccess(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeUndefined();
  return client.lastResult;
}

async function waitForError(client: NebulaClientTest) {
  await waitForResult(client);
  expect(client.lastError).toBeDefined();
  return client.lastError!;
}

// Helper: create a resource at the root node and return its eTag.
async function createResource(
  client: NebulaClientTest,
  star: string,
  resourceId: string,
  title = 'Test Task',
  nodeId = ROOT_NODE_ID,
) {
  client.callStarTransaction(star, ONTOLOGY_VERSION, {
    [resourceId]: { op: 'create', typeName: 'TestResource', nodeId, value: { title } },
  });
  const result = await waitForSuccess(client) as TransactionResult;
  if (!result.ok) throw new Error('Expected create ok');
  return result.eTags[resourceId];
}

describe('star-subscribe', () => {

  it('subscribe to existing resource delivers initial snapshot via handleResourceUpdate', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const resourceId = generateUuid();
    const eTag = await createResource(client, star, resourceId, 'Hello');

    client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForResult(client);

    expect(client.lastError).toBeUndefined();
    expect(client.lastResourceUpdate).toBeDefined();
    expect(client.lastResourceUpdate!.resourceType).toBe('TestResource');
    expect(client.lastResourceUpdate!.resourceId).toBe(resourceId);
    const snap = client.lastResourceUpdate!.snapshot as Snapshot;
    expect(snap.value.title).toBe('Hello');
    expect(snap.meta.eTag).toBe(eTag);
    expect(snap.meta.typeName).toBe('TestResource');
    expect(snap.meta.deleted).toBe(false);

    client[Symbol.dispose]();
  });

  it('subscribe to non-existent resource returns error', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const missingId = generateUuid();

    client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', missingId);
    const err = await waitForError(client);
    expect(err).toContain('not found');
    expect(err).toContain('subscribe before create');

    client[Symbol.dispose]();
  });

  it('subscribe with stale ontology version returns mismatch error', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const resourceId = generateUuid();
    await createResource(client, star, resourceId);

    // Register a newer ontology version on Galaxy so v1 becomes stale
    const galaxyName = star.split('.').slice(0, 2).join('.');
    client.callGalaxyAppendOntologyVersion(galaxyName, {
      version: 'v2',
      types: TEST_TYPES,
    });
    await waitForResult(client);

    // Force Star to pick up v2 by issuing any v2 operation first (mutates Star's cache)
    // — then subscribe with the now-stale v1
    client.callStarRead(star, 'v2', resourceId);
    await waitForResult(client); // result irrelevant; we just need Star to learn v2

    client.callStarSubscribe(star, ONTOLOGY_VERSION /* 'v1' */, 'TestResource', resourceId);
    const err = await waitForError(client);
    expect(err).toContain('Ontology version mismatch');

    client[Symbol.dispose]();
  });

  it('subscribe without read permission returns permission error', async () => {
    const star = uniqueStar();
    const { client: admin, accessToken } = await adminClient(star);

    // Admin creates a private node + resource there
    admin.callStarCreateNode(star, ROOT_NODE_ID, 'private', 'Private');
    await waitForResult(admin);
    const nodeId = admin.lastResult as number;

    const resourceId = generateUuid();
    await createResource(admin, star, resourceId, 'Secret', nodeId);

    // Non-admin user with no permission
    const { client: user } = await userClient(star, accessToken);

    user.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    const err = await waitForError(user);
    expect(err).toContain('read permission required');

    admin[Symbol.dispose]();
    user[Symbol.dispose]();
  });

  it('re-subscribe is idempotent: single row, fresh initial push each call', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const resourceId = generateUuid();
    await createResource(client, star, resourceId);

    // First subscribe
    client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForResult(client);
    expect(client.lastResourceUpdate).toBeDefined();
    expect(client.resourceUpdateCount).toBe(1);

    // Second subscribe (same clientId, rt, rid)
    client.callStarSubscribe(star, ONTOLOGY_VERSION, 'TestResource', resourceId);
    await waitForResult(client);
    expect(client.lastResourceUpdate).toBeDefined();
    // resetResults() inside callStarSubscribe zeroes the counter, so each subscribe
    // surfaces exactly one initial push — assert on the rebuilt counter
    expect(client.resourceUpdateCount).toBe(1);

    // Inspect the table: single row, not two
    client.callStarInspectSubscribers(star);
    const rows = await waitForSuccess(client) as SubscriberRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].resourceId).toBe(resourceId);
    expect(rows[0].sub).toBeDefined();
    expect(rows[0].clientId).toBeDefined();
    expect(rows[0].subscriberBinding).toBe('NEBULA_CLIENT_GATEWAY');
    expect(rows[0].subscribedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    client[Symbol.dispose]();
  });

  it('subscribe with mismatched resourceType returns type-mismatch error', async () => {
    const star = uniqueStar();
    const { client } = await adminClient(star);
    const resourceId = generateUuid();
    await createResource(client, star, resourceId);

    client.callStarSubscribe(star, ONTOLOGY_VERSION, 'WrongType', resourceId);
    const err = await waitForError(client);
    expect(err).toContain('type mismatch');
    expect(err).toContain('TestResource');
    expect(err).toContain('WrongType');

    // No subscriber row should have been written
    client.callStarInspectSubscribers(star);
    const rows = await waitForSuccess(client) as SubscriberRow[];
    expect(rows).toHaveLength(0);

    client[Symbol.dispose]();
  });
});
