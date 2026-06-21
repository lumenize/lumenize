/**
 * Phase 4: Lifecycle and eviction tests for the per-version cache.
 *
 * Verifies the single-row invariant: Star's KV holds at most one
 * `ontology:<version>` row at any time, with `_index` as a one-element array
 * matching it. New rows replace old ones atomically inside `transactionSync`.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { createAuthenticatedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

function galaxyName(star: string): string {
  return star.split('.').slice(0, 2).join('.');
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

async function adminClient(star: string) {
  const browser = new Browser();
  return createAuthenticatedClient(NebulaClientTest, browser, star, star, 'admin@example.com');
}

const TODO = `interface Todo { title: string; done: boolean; }`;

describe('Star ontology lifecycle', () => {

  it('single-row invariant: cache replacement is atomic; index tracks full history', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    // Append v1 and warm Star's cache via a transaction
    client.callStarApplyOntology(star,{ version: 'v1', types: TODO });
    await waitForSuccess(client);

    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    await waitForSuccess(client);

    client.callStarInspectOntologyKv(star);
    let kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
    expect(kv.index).toEqual(['v1']);
    expect(kv.rowVersions).toEqual(['v1']);

    // Append v2 and force Star to fetch it
    client.callStarApplyOntology(star,{ version: 'v2', types: TODO });
    await waitForSuccess(client);

    client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false } },
    });
    await waitForSuccess(client);

    // The v1 row must be gone, replaced by v2 — but the index keeps the
    // full version history so 5.5's lazy migration has the chain.
    client.callStarInspectOntologyKv(star);
    kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
    expect(kv.index).toEqual(['v1', 'v2']);
    expect(kv.rowVersions).toEqual(['v2']);

    client[Symbol.dispose]();
  });

  it('soak: N version switches leave only the current row; index tracks full history', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    const N = 6;
    const expectedHistory: string[] = [];
    for (let i = 1; i <= N; i++) {
      const version = `v${i}`;
      expectedHistory.push(version);

      client.callStarApplyOntology(star,{ version, types: TODO });
      await waitForSuccess(client);

      // Force Star to cache this version
      client.callStarTransaction(star, version, {
        [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: `t${i}`, done: false } },
      });
      const result = await waitForSuccess(client) as TransactionResult;
      expect(result.ok).toBe(true);

      // Invariant: exactly one row (the latest), index has the full history
      client.callStarInspectOntologyKv(star);
      const kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
      expect(kv.index).toEqual(expectedHistory);
      expect(kv.rowVersions).toEqual([version]);
    }

    client[Symbol.dispose]();
  });

  it('post-switch: stale-tagged transaction rejected with current version in error', async () => {
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star,{ version: 'v1', types: TODO });
    await waitForSuccess(client);
    client.callStarApplyOntology(star,{ version: 'v2', types: TODO });
    await waitForSuccess(client);

    // Cache v2 on Star
    client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    await waitForSuccess(client);

    // Stale v1 transaction
    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'b', done: false } },
    });
    const error = await waitForError(client);
    expect(error).toContain('version mismatch');
    expect(error).toContain("'v1'");
    expect(error).toContain("'v2'");

    // KV state untouched by the rejected transaction — full history preserved
    client.callStarInspectOntologyKv(star);
    const kv = await waitForSuccess(client) as { index: string[]; rowVersions: string[] };
    expect(kv.index).toEqual(['v1', 'v2']);
    expect(kv.rowVersions).toEqual(['v2']);

    client[Symbol.dispose]();
  });

  it('rapid back-to-back transactions on the new version succeed after a switch', async () => {
    // Validates the cache-hit path immediately after a switch — confirms the
    // new facet was installed atomically with the new row.
    const star = uniqueStar();
    const galaxy = galaxyName(star);
    const { client } = await adminClient(star);

    client.callStarApplyOntology(star,{ version: 'v1', types: TODO });
    await waitForSuccess(client);
    client.callStarTransaction(star, 'v1', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'seed', done: false } },
    });
    await waitForSuccess(client);

    client.callStarApplyOntology(star,{ version: 'v2', types: TODO });
    await waitForSuccess(client);

    // First v2 transaction triggers the switch (cache miss)
    client.callStarTransaction(star, 'v2', {
      [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: 'a', done: false } },
    });
    const r1 = await waitForSuccess(client) as TransactionResult;
    expect(r1.ok).toBe(true);

    // Subsequent v2 transactions must use the cache (hit path)
    for (let i = 0; i < 3; i++) {
      client.callStarTransaction(star, 'v2', {
        [generateUuid()]: { op: 'create', typeName: 'Todo', nodeId: ROOT_NODE_ID, value: { title: `b${i}`, done: false } },
      });
      const r = await waitForSuccess(client) as TransactionResult;
      expect(r.ok).toBe(true);
    }

    client[Symbol.dispose]();
  });
});
