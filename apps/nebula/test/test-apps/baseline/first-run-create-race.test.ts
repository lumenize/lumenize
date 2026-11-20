/**
 * Race-safe first-run container create (§5.3.7-v3 "First-run container create" +
 * §5.3.8) — real Star.
 *
 * The coding-your-ui § Lists bootstrap attaches a `todoList` under a node the user can write.
 * When two tabs of ONE person first-create it concurrently with the same value, the second create
 * is a repeat of the first: it is recognized from the snapshot the first wrote and told
 * `committed` at the same moment. When two DIFFERENT people race the same id, the second is no
 * repeat — its create hits "already exists" and comes back non-`committed`. The pinned app pattern
 * is read-then-create with a `committed`-disambiguation re-read: a non-`committed` top-level means
 * "didn't land", so re-read — list present ⇒ someone won the race, proceed; still absent ⇒ real
 * failure.
 *
 * The clients authenticate as a NON-scope-admin member granted `write` on ROOT, so
 * create-under-ROOT is authorized by the DAG grant alone — a `claims.access.scopeAdmin`
 * user would pass even if the grant were absent or broken, through the dominion bypass.
 *
 * Capable-of-failing: the one-person race asserts both tabs are told `committed` at one moment
 * (deleting recognition makes the second fail "already exists"); the two-person race asserts the
 * loser came back NOT `committed` (keying recognition on the value alone would commit both); the
 * serialized control asserts the second tab sees the list already present and never enters the
 * create branch — so a harness that never actually races still can't pass the race assertions.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID } from '@lumenize/resources';
import type { TransactionOutcome } from '@lumenize/resources';
import { adminClientAt, createInvitedClient, createSubject } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TYPES = `interface TodoList { items: string[]; }`;

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

async function awaitCall(c: NebulaClientTest): Promise<unknown> {
  await vi.waitFor(() => { expect(c.callCompleted).toBe(true); });
  return c.lastResult;
}

/**
 * Admin (scope-admin, acting through the bypass with no grant of its own) installs the
 * ontology and grants a SECOND, non-scope-admin member `write` on ROOT. Returns
 * the member's sub so its create-under-ROOT relies on the DAG grant, not scope-admin.
 */
async function setupGrantedMember(star: string) {
  const admin = await adminClientAt(NebulaClientTest, new Browser(), star, star, 'admin@example.com');
  const galaxyName = star.split('.').slice(0, 2).join('.');
  admin.client.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TYPES });
  await awaitCall(admin.client);

  await createSubject(new Browser(), star, admin.accessToken, 'member@example.com');
  const probe = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
  const sub = probe.payload.sub;
  // Guard: the member must NOT be a scope-admin — otherwise create-under-ROOT could
  // pass via the claims.access.scopeAdmin bypass and mask a missing/broken DAG grant.
  expect((probe.payload as { access?: { scopeAdmin?: boolean } }).access?.scopeAdmin).toBeFalsy();
  probe.client[Symbol.dispose]();

  admin.client.callStarSetPermission(star, ROOT_NODE_ID, sub, 'write');
  await awaitCall(admin.client);
  return { admin, sub };
}

/** A second granted member, a different person from `setupGrantedMember`'s. */
async function grantSecondMember(star: string, admin: { client: NebulaClientTest; accessToken: string }) {
  await createSubject(new Browser(), star, admin.accessToken, 'second@example.com');
  const second = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'second@example.com');
  admin.client.callStarSetPermission(star, ROOT_NODE_ID, second.payload.sub, 'write');
  await awaitCall(admin.client);
  return second;
}

const createList = (c: NebulaClientTest, listId: string) => c.resources.transaction({
  [listId]: { op: 'create', typeName: 'TodoList', nodeId: ROOT_NODE_ID, value: { items: [] } },
});
const momentOf = (o: TransactionOutcome, rid: string) =>
  o.kind === 'committed' && o.resources[rid]?.kind === 'committed'
    ? (o.resources[rid] as { validFrom: string }).validFrom : undefined;

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
  it('one person, two tabs racing the first-create: both are told committed at one moment', async () => {
    const star = uniqueStar();
    const { admin, sub } = await setupGrantedMember(star);
    // Two tabs for the SAME member (same sub, distinct tabId/instanceName).
    const tab1 = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const tab2 = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const listId = `todolist-${sub}`;

    // Both tabs read first — both see "absent", so both ENTER the create branch.
    expect(await tab1.client.resources.read('TodoList', listId)).toBeNull();
    expect(await tab2.client.resources.read('TodoList', listId)).toBeNull();

    const [o1, o2] = await Promise.all([createList(tab1.client, listId), createList(tab2.client, listId)]);
    expect([o1.kind, o2.kind]).toEqual(['committed', 'committed']);
    expect(momentOf(o1, listId)).toBeDefined();
    expect(momentOf(o2, listId)).toBe(momentOf(o1, listId));
    expect(await tab1.client.resources.read('TodoList', listId)).not.toBeNull();

    admin.client[Symbol.dispose]();
    tab1.client[Symbol.dispose]();
    tab2.client[Symbol.dispose]();
  });

  it('two people racing the first-create of one id: one commits, the loser is NOT committed, both end present', async () => {
    const star = uniqueStar();
    const { admin } = await setupGrantedMember(star);
    const first = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const second = await grantSecondMember(star, admin);
    const listId = `shared-list-${crypto.randomUUID().slice(0, 8)}`;

    const [o1, o2] = await Promise.all([createList(first.client, listId), createList(second.client, listId)]);
    // Exactly one committed; the other is the race loser and is NOT committed
    // (proving the disambiguation branch must run — not a spurious success).
    const committed = [o1, o2].filter((o) => o.kind === 'committed');
    expect(committed.length).toBe(1);
    const loser = o1.kind === 'committed' ? o2 : o1;
    expect(loser.kind).not.toBe('committed');

    // The loser re-reads to disambiguate: list now present ⇒ someone won ⇒ proceed.
    const loserClient = o1.kind === 'committed' ? second : first;
    expect(await loserClient.client.resources.read('TodoList', listId)).not.toBeNull();
    expect(await first.client.resources.read('TodoList', listId)).not.toBeNull();
    expect(await second.client.resources.read('TodoList', listId)).not.toBeNull();

    admin.client[Symbol.dispose]();
    first.client[Symbol.dispose]();
    second.client[Symbol.dispose]();
  });

  it('serialized (non-contended): the second tab sees the list present and never enters the create branch', async () => {
    const star = uniqueStar();
    const { admin, sub } = await setupGrantedMember(star);
    const tab1 = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
    const tab2 = await createInvitedClient(NebulaClientTest, new Browser(), star, star, 'member@example.com');
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
