/**
 * Race-safe first-run container create (§5.3.7-v3 "First-run container create" +
 * §5.3.8) — real Star.
 *
 * The coding-your-ui § Lists bootstrap attaches a per-user `todoList` under a node
 * the user can write. When two tabs first-create it concurrently they use DIFFERENT
 * `newETag`s, so the idempotency replay short-circuit does NOT apply — the loser's
 * create hits "already exists" and comes back non-`committed`. The pinned app
 * pattern (NOT the heavier typed-`already-exists` taxonomy change) is
 * read-then-create with a `committed`-disambiguation re-read: a non-`committed`
 * top-level means "didn't land", so re-read — list present ⇒ a tab won the race,
 * proceed; still absent ⇒ real failure.
 *
 * The clients authenticate as a NON-scope-admin member granted `write` on ROOT, so
 * create-under-ROOT is authorized by the DAG grant alone — a `claims.access.admin`
 * user would pass even if the grant were absent/broken (the seeded-founder intent).
 *
 * Capable-of-failing: the contended run asserts the loser came back NOT `committed`
 * (the disambiguation branch ran); the serialized control asserts the second tab
 * sees the list already present and never enters the create branch — so a harness
 * that never actually races still can't pass the loser-path assertion.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import type { TransactionOutcome } from '@lumenize/nebula';
import { createAuthenticatedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TYPES = `interface TodoList { items: string[]; }`;

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

async function awaitCall(c: NebulaClientTest): Promise<unknown> {
  await vi.waitFor(() => { expect(c.callCompleted).toBe(true); });
  return c.lastResult;
}

/**
 * Admin (scope-admin — founder-seeding fires for it on first touch) installs the
 * ontology and grants a SECOND, non-scope-admin member `write` on ROOT. Returns
 * the member's sub so its create-under-ROOT relies on the DAG grant, not scope-admin.
 */
async function setupGrantedMember(star: string) {
  const admin = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  admin.client.callGalaxyAppendOntologyVersion(galaxyName, { version: ONTOLOGY_VERSION, types: TYPES });
  await awaitCall(admin.client);

  await createSubject(new Browser(), star, admin.accessToken, 'member@example.com');
  const probe = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
  const sub = probe.payload.sub;
  // Guard: the member must NOT be a scope-admin — otherwise create-under-ROOT could
  // pass via the claims.access.admin bypass and mask a missing/broken DAG grant.
  expect((probe.payload as { access?: { admin?: boolean } }).access?.admin).toBeFalsy();
  probe.client[Symbol.dispose]();

  admin.client.callStarSetPermission(star, ROOT_NODE_ID, sub, 'write');
  await awaitCall(admin.client);
  return { admin, sub };
}

/** The coding-your-ui § Lists pattern: read-then-create with committed-disambiguation. */
async function ensureList(
  client: NebulaClientTest, listId: string,
): Promise<{ enteredCreate: boolean; outcome?: TransactionOutcome }> {
  const existing = await client.resources.read('TodoList', listId);
  if (existing && !existing.meta.deleted) return { enteredCreate: false };
  const outcome = await client.resources.transaction({
    [listId]: { op: 'create', typeName: 'TodoList', nodeId: ROOT_NODE_ID, value: { items: [] } },
  });
  return { enteredCreate: true, outcome };
}

describe('first-run container create — race-safe (real Star)', () => {
  it('contended: two tabs race the first-create → one commits, the loser is NOT committed, both end present', async () => {
    const star = uniqueStar();
    const { admin, sub } = await setupGrantedMember(star);
    // Two tabs for the SAME member (same sub, distinct tabId/instanceName).
    const tab1 = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const tab2 = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const listId = `todolist-${sub}`;

    // Both tabs read first — both see "absent", so both ENTER the create branch.
    expect(await tab1.client.resources.read('TodoList', listId)).toBeNull();
    expect(await tab2.client.resources.read('TodoList', listId)).toBeNull();

    // Race the two creates (different newETags → no replay short-circuit).
    const [o1, o2] = await Promise.all([
      tab1.client.resources.transaction({ [listId]: { op: 'create', typeName: 'TodoList', nodeId: ROOT_NODE_ID, value: { items: [] } } }),
      tab2.client.resources.transaction({ [listId]: { op: 'create', typeName: 'TodoList', nodeId: ROOT_NODE_ID, value: { items: [] } } }),
    ]);

    // Exactly one committed; the other is the race loser and is NOT committed
    // (proving the disambiguation branch must run — not a spurious success).
    const committed = [o1, o2].filter((o) => o.kind === 'committed');
    expect(committed.length).toBe(1);
    const loser = o1.kind === 'committed' ? o2 : o1;
    expect(loser.kind).not.toBe('committed');

    // The loser re-reads to disambiguate: list now present ⇒ a tab won ⇒ proceed.
    const loserClient = o1.kind === 'committed' ? tab2 : tab1;
    expect(await loserClient.client.resources.read('TodoList', listId)).not.toBeNull();

    // Both tabs end with the list present.
    expect(await tab1.client.resources.read('TodoList', listId)).not.toBeNull();
    expect(await tab2.client.resources.read('TodoList', listId)).not.toBeNull();

    admin.client[Symbol.dispose]();
    tab1.client[Symbol.dispose]();
    tab2.client[Symbol.dispose]();
  });

  it('serialized (non-contended): the second tab sees the list present and never enters the create branch', async () => {
    const star = uniqueStar();
    const { admin, sub } = await setupGrantedMember(star);
    const tab1 = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const tab2 = await createAuthenticatedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const listId = `todolist-${sub}`;

    // Tab 1 creates first (awaited → committed).
    const r1 = await ensureList(tab1.client, listId);
    expect(r1.enteredCreate).toBe(true);
    expect(r1.outcome!.kind).toBe('committed');

    // Tab 2 then sees the list present and skips the create entirely — the
    // distinguishing signal from the contended run (a non-racing harness would
    // always land here and never exercise the loser path above).
    const r2 = await ensureList(tab2.client, listId);
    expect(r2.enteredCreate).toBe(false);

    admin.client[Symbol.dispose]();
    tab1.client[Symbol.dispose]();
    tab2.client[Symbol.dispose]();
  });
});
