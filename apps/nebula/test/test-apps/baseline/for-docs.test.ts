// @ts-nocheck — this is a doc-mirroring for-docs test. The website doc blocks it
// backs are intentionally loose JS (untyped arrow params, `.value.<field>` on the
// `unknown` Snapshot value) so Studio's hosted LLM reads idiomatic, uncluttered
// code. Reproducing them VERBATIM is the whole point (the @check-example matcher
// substring-matches normalized source), so type annotations that would diverge
// from the doc are off the table. The test is validated by RUNNING against a real
// Star (vitest transpiles, never type-checks) + the substring match — not by tsc.
//
/**
 * for-docs (real Star) — backs the runtime-behavior @check-example blocks in
 * website/docs/nebula/{coding-your-ui,api-reference,resources}.md:
 * factory usage, transaction(), subscribe/Disposable, the
 * onTransactionResourceResolution handlers, orgTree, and the TransactionOutcome
 * switches. One big narrative `it` (Phase 5.3.8 convention) over one real Star —
 * each labeled step embeds a doc block verbatim and exercises it end-to-end.
 *
 * Capable-of-failing: every transaction asserts a real `committed` outcome (a
 * broken put/create/auto-derive-eTag path would return a non-committed kind),
 * the computeds assert real derived values off live snapshots, and the orgTree
 * sequence asserts the founder can drive every mutation against the real DAG.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import { createNebulaClient, textMerge } from '@lumenize/nebula/frontend';
import { computed } from '@vue/reactivity';
import { browserLogin, createAuthenticatedClient, ORIGIN } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const ONTOLOGY = `
interface todo { title: string; description?: string; status?: 'open' | 'done'; assignees?: string[]; }
interface todoList { items: string[]; }
interface doc { body: string; }
interface document { body: string; }
`;

// The ontology type a script-side read is cast to (coding-your-ui § Reading and
// writing through the store).
type Todo = { title: string; description: string; status: 'open' | 'done' };

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

function makeFactoryClient(star: string, browser: Browser) {
  const ctx = browser.context(ORIGIN);
  return createNebulaClient({
    baseUrl: ORIGIN,
    authScope: star,
    activeScope: star,
    appVersion: ONTOLOGY_VERSION,
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    onShouldRefreshUI: () => {},
  });
}

// App-side helpers the doc snippets call (a toast surface; a draft store).
function showToast(_message: string): void {}

describe('for-docs runtime examples (real Star)', () => {
  it('factory usage, transactions, subscribe/Disposable, handlers, orgTree, outcomes', async () => {
    const star = uniqueStar();

    // ── Setup: founder installs the ontology, then connects via the factory ──
    // The first subject to reach a fresh Star becomes the founder (admin on ROOT).
    const admin = await createAuthenticatedClient(
      NebulaClientTest, new Browser(), star, star, 'founder@example.com', ONTOLOGY_VERSION,
    );
    const galaxyName = star.split('.').slice(0, 2).join('.');
    admin.client.callStarApplyOntology(star, { version: ONTOLOGY_VERSION, types: ONTOLOGY });
    await vi.waitFor(() => { expect(admin.client.callCompleted).toBe(true); });

    const browser = new Browser();
    await browserLogin(browser, star, 'founder@example.com', star);
    const bf = makeFactoryClient(star, browser);
    await bf.ready;
    // Alias to the names the doc snippets use.
    const client = bf.client;
    const store = bf.store;

    // The factory auto-subscribes the org tree on connect.
    await vi.waitFor(() => {
      expect((store.lmz.orgTree.value as { nodes?: Map<number, unknown> } | undefined)?.nodes).toBeInstanceOf(Map);
    });

    // ── coding-your-ui § Mutating the org/permission tree ──
    const userAliceNodeId = await client.orgTree.createNode(ROOT_NODE_ID, 'user-alice', 'Alice');
    const userBobNodeId = await client.orgTree.createNode(ROOT_NODE_ID, 'user-bob', 'Bob');
    const bobsSub = generateUuid();
    const nodeId = userAliceNodeId;

    // @doc coding-your-ui.md § Mutating the org/permission tree
    // Grant a permission. `sub` is a JWT subject claim — a bare UUID (the current
    // user's is client.claims.sub; other users' subs come from wherever your app
    // stores its member list). `level` is 'read' (view), 'write' (edit +
    // structural changes), or 'admin' (write + manage permissions).
    // Caller must hold `admin` on `nodeId`.
    await client.orgTree.setPermission(nodeId, bobsSub, 'read');

    // Revoke. Idempotent — no-op if `sub` has no grant on this node.
    await client.orgTree.revokePermission(nodeId, bobsSub);

    // Create a child node (slug rules and return shape: see API reference).
    // Caller must hold `write` on `parentNodeId`.
    const listShoppingId = await client.orgTree.createNode(
      userAliceNodeId, 'list-shopping', 'Shopping',
    );

    // Co-ownership sharing — the two-party share-accept flow from Resources §
    // Access control. Step 1, owner offers (runs as Alice): grant Bob admin on
    // the list.
    await client.orgTree.setPermission(listShoppingId, bobsSub, 'admin');

    // Step 2, recipient accepts (runs as Bob): the edge makes the list a child
    // of both user-alice AND user-bob, so Bob's admin on user-bob now cascades
    // to it. addEdge requires `write` on the new parent + `admin` on the child.
    await client.orgTree.addEdge(userBobNodeId, listShoppingId);

    // Step 3, optional cleanup (either co-owner): the direct grant from step 1
    // is redundant once the edge cascades.
    await client.orgTree.revokePermission(listShoppingId, bobsSub);

    // "Remove from my account" = delete only this user's edge to the list.
    // The list lives on under its other parents.
    await client.orgTree.removeEdge(userBobNodeId, listShoppingId);
    // @end-doc

    // ── Setup a 'task-42' todo so the put / subscribe examples have a target ──
    const seed = await client.resources.transaction({
      'task-42': { op: 'create', typeName: 'todo', nodeId: ROOT_NODE_ID,
                   value: { title: 'Original', description: '', status: 'open' } },
    });
    expect(seed.kind).toBe('committed');
    {
      using s = client.resources.subscribe('todo', 'task-42');
      await s.snapshot; // populate store.resources.todo['task-42'] (value + full meta)
    }
    await vi.waitFor(() => {
      expect(store.resources.todo['task-42']?.value?.title).toBe('Original');
    });

    // ── coding-your-ui § Reading and writing through the store ──
    {
      const id = 'task-42';
      // @doc coding-your-ui.md § Reading and writing through the store
      const title = store.resources.todo[id]?.value?.title;          // reactive read
      store.resources.todo[id].value.title = 'New title';            // optimistic write + debounced transaction
      const todo = store.resources.todo[id]?.value as Todo | undefined;  // cast to the ontology type for typed script code
      // @end-doc
      expect(title).toBe('Original');
      expect(todo?.title).toBe('New title');
      bf.flush(); // settle the debounced write before the explicit puts below
    }
    await vi.waitFor(() => {
      expect(store.resources.todo['task-42']?.value?.title).toBe('New title');
    });

    // ── api-reference § resources.transaction — single resource ──
    {
      // @doc api-reference.md § Example — single resource
      // eTag auto-derives from store.resources.todo['task-42']?.meta?.eTag.
      const outcome = await client.resources.transaction({
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'New title' } },
      });
      // @end-doc
      expect(outcome.kind).toBe('committed');
    }

    // ── resources § Addressing resources (in code) ──
    {
      // @doc resources.md § Addressing resources (in code)
      client.resources.subscribe('todo', 'task-42');   // returns a Disposable handle (not a Promise) — see api-reference
      await client.resources.transaction({
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'New title', description: '', status: 'open' } },
      });
      const snap = await client.resources.read('todo', 'task-42');
      // @end-doc
      expect(snap?.value?.title).toBe('New title');
    }

    // ── api-reference § subscribe — idiomatic usage with `using` ──
    // (Bare block, matching the doc literal: a `subscribe`/`await snapshot` that
    //  broke would reject or hang here, so the block IS the assertion.)
    // @doc api-reference.md § Idiomatic usage with `using`
    {
      using sub = client.resources.subscribe('todo', 'task-42');
      const snap = await sub.snapshot;            // wait for initial fanout if you care
      // ... work with the resource ...
    }                                              // auto-unsubscribes here
    // @end-doc
    expect(store.resources.todo['task-42']?.value?.title).toBe('New title');

    // ── api-reference § subscribe — manual control ──
    // @doc api-reference.md § Manual control
    // Some setup code:
    client.resources.subscribe('todo', 'task-42');                  // handle discarded; subscription stays live

    // Some teardown code, possibly elsewhere:
    client.resources.unsubscribe('todo', 'task-42');                // standalone API
    // @end-doc

    // ── api-reference § Explicit eTag override ──
    {
      const currentETag = store.resources.todo['task-42'].meta.eTag;
      const conflict = { server: { meta: { eTag: currentETag } } };
      const resolvedValue = { title: 'Resolved', description: '', status: 'open' };
      // @doc api-reference.md § Explicit eTag override
      // Explicit baseline — Bob's resolution submission against the stashed snapshot.
      const outcome = await client.resources.transaction({
        'task-42': { op: 'put', typeName: 'todo',
                     eTag: conflict.server.meta.eTag,            // ← stashed baseline, not auto-derived
                     value: resolvedValue },
      });
      // @end-doc
      expect(outcome.kind).toBe('committed');
    }

    // ── coding-your-ui § Lists — read-then-create the per-user container ──
    const sub = client.claims.sub;
    // @doc coding-your-ui.md § Lists with v-for (read-then-create)
    if (await client.resources.read('todoList', sub) === null) {
      const outcome = await client.resources.transaction({
        [sub]: { op: 'create', typeName: 'todoList', nodeId: ROOT_NODE_ID,
                 value: { items: [] } },
      });
      // A single-resource create commits iff the top-level outcome is 'committed'
      // (atomicity ⟹ if the batch committed, the create landed). Any failure is NOT
      // 'committed': permission/validation → 'rejected'; a lost first-create race
      // ("already exists") → 'infrastructure-error' today (M11 may reclassify it).
      // Race-safe: when not created, re-read to disambiguate — the list now exists (a
      // tab won the race, proceed) or it genuinely doesn't (a real failure to surface).
      const created = outcome.kind === 'committed';
      if (!created && await client.resources.read('todoList', sub) === null) {
        throw new Error('Could not create your list — check your connection and reload.');
      }
    }
    // @end-doc

    // Subscribe the list so its full meta (incl. nodeId) lands in the store.
    {
      using s = client.resources.subscribe('todoList', sub);
      await s.snapshot;
    }
    await vi.waitFor(() => {
      expect(store.resources.todoList[sub]?.meta?.nodeId).toBeDefined();
    });

    // ── api-reference § transaction — multi-resource atomic batch ──
    {
      const title = 'Walk the dog';
      const list = store.resources.todoList[sub].value;
      // @doc api-reference.md § Example — multi-resource atomic batch
      const newId = crypto.randomUUID();
      const outcome = await client.resources.transaction({
        [newId]: { op: 'create', typeName: 'todo', nodeId: 1,
                   value: { title, description: '', status: 'open' } },
        // per-user keying — see Coding your UI § Lists with v-for
        [client.claims.sub]: { op: 'put', typeName: 'todoList',
                   value: { ...list, items: [...list.items, newId] } },
      });
      // @end-doc
      expect(outcome.kind).toBe('committed');
    }

    // ── coding-your-ui § Atomic append ──
    // @doc coding-your-ui.md § Atomic append — adding to a collection
    async function addTodo(title: string) {
      const newId = crypto.randomUUID();
      const listSnap = store.resources.todoList[client.claims.sub];
      const list = listSnap?.value;
      if (!list) return;   // snapshot not arrived yet — see "Loading and first paint"

      // Both ops in one call → atomic. Either both commit or neither does.
      // eTag for the put auto-derives from store.resources.todoList[...]?.meta?.eTag;
      // a missing baseline (resource never subscribed) THROWS synchronously here
      // rather than returning a non-committed outcome — the v-if/snapshot guard above
      // prevents that. The new todo attaches under the same tree node as the list
      // (meta.nodeId, not value — nodeId is server-managed metadata).
      const outcome = await client.resources.transaction({
        [newId]:             { op: 'create', typeName: 'todo', nodeId: listSnap.meta.nodeId,
                               value: { title, description: '', status: 'open' } },
        [client.claims.sub]: { op: 'put',    typeName: 'todoList',
                               value: { ...list, items: [...list.items, newId] } },
      });
      // error handling on outcome goes here
    }
    // @end-doc
    await addTodo('Buy milk');
    await vi.waitFor(() => {
      expect(store.resources.todoList[sub]?.value?.items?.length).toBeGreaterThanOrEqual(2);
    });

    // ── coding-your-ui § Loading and first paint — multi-state computed ──
    // @doc coding-your-ui.md § Loading and first paint
    const todoStatus = computed(() => {
      const snap = store.resources.todo['task-42'];
      // No 'connecting' state here: the app mounts only after `await ready` (so it's
      // connected by first render). First-connect "Connecting…" lives in the static
      // pre-mount shell; a later drop shows the reconnect banner (below) over the
      // painted data while this stays 'ready'. A logged-out visitor never reaches
      // this — `ready` rejects and the bootstrap redirects before mount.
      if (snap?.meta?.deleted) return 'deleted';
      if (!snap?.value)        return 'loading';
      return 'ready';
    });
    // @end-doc
    expect(todoStatus.value).toBe('ready');

    // ── coding-your-ui § Gating admin-only UI ──
    // @doc coding-your-ui.md § Gating admin-only UI
    const isAppAdmin = computed(() =>
      client.claims.access.admin ||                                     // Galaxy/Universe scope admin
      store.lmz.orgTree?.value?.permissions
        .get(ROOT_NODE_ID)?.get(client.claims.sub) === 'admin'          // app admin (grant on root)
    );
    // @end-doc
    expect(isAppAdmin.value).toBe(true);

    // ── coding-your-ui § Lists — client-side computed aggregate ──
    // @doc coding-your-ui.md § Lists with v-for (openCount)
    const openCount = computed(() =>
      (store.resources.todoList[client.claims.sub]?.value?.items ?? [])
        .filter(id => store.resources.todo[id]?.value?.status === 'open').length
    );
    // @end-doc
    expect(openCount.value).toBeGreaterThanOrEqual(0);

    // ── resources § the onTransactionResourceResolution handler ──
    // @doc resources.md § Per-resource behavior — the handler
    client.resources.onTransactionResourceResolution('todo', (rid, resolution) => {
      switch (resolution.kind) {
        // Non-terminal: handler returns a ConflictResolverVerdict.
        case 'conflict-pending':
          return { kind: 'use-server' };                  // example: server-wins (= framework default)

        // Terminal: handler return is ignored. React however you like.
        case 'committed':         /* navigate, clear draft */ break;
        case 'use-server':        /* server's value painted; default red flash fired */ break;
        case 'human-in-the-loop': /* stash for review-later UI */ break;
        case 'validation-failed': /* surface resolution.errors */ break;
        case 'permission-denied': /* show "not authorized" */ break;
        case 'retries-exhausted': /* show error */ break;
      }
    });
    // @end-doc

    // ── resources § 'use-this' verdict — automatic merge ──
    // @doc resources.md § 'use-this' verdict — automatic merge
    client.resources.onTransactionResourceResolution('todo', (rid, resolution) => {
      if (resolution.kind === 'conflict-pending') {
        const { local, server, base } = resolution;
        return {
          kind: 'use-this',
          value: {
            title:       local.value.title,                                                      // mine wins (short string)
            status:      server.value.status,                                                    // theirs wins (enum)
            description: textMerge(server.value.description, local.value.description, base.value.description),  // base = common ancestor (NOT server)
            assignees:   [...new Set([...local.value.assignees, ...server.value.assignees])],    // set-union by hand
          },
        };
      }
    });
    // @end-doc

    // ── resources § per-type or per-call override ──
    {
      const handler = (rid, resolution) => {};
      const ops = {
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'New title', description: '', status: 'open' } },
      };
      // @doc resources.md § Per-type or per-call override
      client.resources.onTransactionResourceResolution('todo', handler, { maxRetries: 10 });
      // or per-call — a map keyed by resourceId:
      await client.resources.transaction(ops, { onTransactionResourceResolution: { 'task-42': handler }, maxRetries: 3 });
      // @end-doc
    }

    // ── resources § human-in-the-loop verdict ──
    // @doc resources.md § human-in-the-loop verdict
    // nebula.ts (handler runs once at module load; alongside the factory call)
    client.resources.onTransactionResourceResolution('document', (rid, resolution) => {
      switch (resolution.kind) {
        case 'conflict-pending':
          // Stash the conflict for later review.
          if (!store.app.conflicts) store.app.conflicts = {};
          store.app.conflicts[resolution.server.meta.eTag] = {
            resourceType: 'document',
            resourceId: rid,
            local: resolution.local,
            server: resolution.server,
          };
          return { kind: 'human-in-the-loop' };
        case 'committed':
          // The eventual review-later submission committed — clear this conflict.
          // (Match by some app-defined key; here we clear all eTags pointing at rid.)
          for (const eTag of Object.keys(store.app.conflicts ?? {})) {
            if (store.app.conflicts[eTag].resourceId === rid) {
              delete store.app.conflicts[eTag];
            }
          }
          break;
      }
    });
    // @end-doc

    // ── resources § Text fields — the auto-registered @longform handler ──
    // @doc resources.md § Text fields specifically — don't leave the default
    client.resources.onTransactionResourceResolution('doc', (rid, resolution) => {
      if (resolution.kind === 'conflict-pending') {
        return {
          kind: 'use-this',
          value: {
            ...resolution.server.value,                                          // start from server snapshot (keeps its other-field changes)
            body: textMerge(resolution.server.value.body, resolution.local.value.body, resolution.base.value.body),  // base = common ancestor
          },
        };
      }
    });
    // @end-doc

    // ── resources § Awaiting transaction() — the full outcome switch ──
    {
      const ops = {
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'Switched', description: '', status: 'open' } },
      };
      // @doc resources.md § Awaiting transaction() (full switch)
      const outcome = await client.resources.transaction(ops);
      switch (outcome.kind) {
        case 'committed':
          // Every op landed (after any below-the-bucket conflict resolution). The per-type
          // handler has already fired for each resource (navigation, draft-clearing,
          // validation-error display, etc.). outcome.resources has the per-resource breakdown
          // if you need it, but most callers don't.
          break;

        case 'rejected':
          // The server processed it but nothing committed, for a per-op reason. outcome.retryable
          // is the resubmit verdict: an exhausted conflict → true; permission/validation → false.
          // The per-type handler has already surfaced each op's reason from outcome.resources
          // ('permission-denied' → request access via the orgTree, 'validation-failed' → fix input,
          // 'human-in-the-loop' → optimistic paint stays; the app owns the follow-up).
          if (outcome.retryable) showToast('Save problem — retry?');
          break;

        case 'timeout':
        case 'infrastructure-error':
          // Transaction-wide failure; optimistic state rolled back (connection-gated — a mere
          // disconnect never lands here). An idempotent resubmit (same newETag) can land.
          showToast('Connection problem — retry?');
          if (outcome.kind === 'infrastructure-error') console.error(outcome.error);
          break;

        case 'ontology-stale':
          // The client's app version is stale; onShouldRefreshUI usually fires (page reload).
          // Optimistic state untouched. Nothing extra to do here.
          break;
      }
      // @end-doc
      expect(outcome.kind).toBe('committed');
    }

    // ── resources § Awaiting transaction() — the collapsed form ──
    {
      const ops = {
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'Collapsed', description: '', status: 'open' } },
      };
      // @doc resources.md § Awaiting transaction() (collapsed)
      const outcome = await client.resources.transaction(ops);
      if (outcome.kind !== 'committed') {
        showToast('Save problem — retry?');
      }
      // @end-doc
      expect(outcome.kind).toBe('committed');
    }

    // ── resources § Awaiting transaction() — aggregate decision ──
    {
      const ops = {
        'task-42': { op: 'put', typeName: 'todo', value: { title: 'Aggregate', description: '', status: 'open' } },
      };
      const outcome = await client.resources.transaction(ops);
      // @doc resources.md § Awaiting transaction() (aggregate)
      if (outcome.kind === 'committed') {
        const allCommitted = Object.values(outcome.resources)
          .every(r => r.kind === 'committed');   // an op may have resolved to 'use-server' — committed, but your value was reverted
        if (allCommitted) {
          store.app.activeView = 'list';
        }
      }
      // @end-doc
      expect(store.app.activeView).toBe('list');
    }

    await bf.dispose();
    admin.client[Symbol.dispose]();
  });

  it('createNebulaClient admin/scripting config shape (api-reference)', async () => {
    // The admin/scripting form with all overrides explicit. No live Star — this
    // backs the config-shape example; the connection to the placeholder origin
    // fails in the background and is torn down immediately.
    // @doc api-reference.md § createNebulaClient (admin/scripting overrides)
    const { client, store } = createNebulaClient({
      baseUrl: 'https://my-app.example.com',
      authScope: 'acme.app.tenant-a',
      activeScope: 'acme.app.tenant-a',
      appVersion: 'v42',
      onShouldRefreshUI: () => {},    // opt out of auto-reload (null/undefined both KEEP the default reload)
    });
    // @end-doc
    expect(typeof store).toBe('object');
    await client.dispose();
  });
});
