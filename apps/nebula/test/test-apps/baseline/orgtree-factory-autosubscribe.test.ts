/**
 * orgTree auto-subscribe-on-connect via the factory (§5.3.8 orgTree probe) —
 * real Star.
 *
 * The baseline `nebula-orgtree.test.ts` tests the server channel via EXPLICIT
 * `subscribeTree`; this covers the factory's auto-subscribe-on-connect path that
 * only `createNebulaClient` exercises: registering the orgTree listener (the
 * factory always does, to mirror `store.lmz.orgTree.value`) opts the client into
 * `subscribeTree` on every `'connected'`. So a factory client lands the synth
 * snapshot at `store.lmz.orgTree.value` with no explicit subscribe, and a
 * `client.orgTree.*` mutation broadcasts to ALL subscribers INCLUDING the
 * originator (the tree has no optimistic local write — the echo is the only
 * update path).
 *
 * (The `reconnecting→connected` re-subscribe needs WS-disconnect tooling → §5.3.7-v4.)
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { generateUuid } from '@lumenize/auth';
import { ROOT_NODE_ID } from '@lumenize/nebula';
import { createNebulaClient } from '@lumenize/nebula/frontend';
import { browserLogin, ORIGIN } from '../../test-helpers';

function uniqueStar(): string {
  return `acme-${generateUuid().slice(0, 8)}.app.tenant-a`;
}

function makeFactoryClient(star: string, browser: Browser) {
  const ctx = browser.context(ORIGIN);
  return createNebulaClient({
    baseUrl: ORIGIN,
    authScope: star,
    activeScope: star,
    appVersion: 'v1',
    fetch: browser.fetch,
    WebSocket: browser.WebSocket,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    onShouldRefreshUI: () => {},
  });
}

function nodeLabels(state: unknown): string[] {
  const nodes = (state as { nodes?: Map<number, { label: string }> } | undefined)?.nodes;
  if (!(nodes instanceof Map)) return [];
  return [...nodes.values()].map((n) => n.label);
}

async function loggedInFactory(star: string) {
  const browser = new Browser();
  await browserLogin(browser, star, 'admin@example.com', star);
  const f = makeFactoryClient(star, browser);
  await f.ready;
  return f;
}

describe('orgTree auto-subscribe-on-connect via the factory (real Star)', () => {
  it('factory auto-subscribes on connect; a client.orgTree mutation broadcasts to both clients (incl. originator)', async () => {
    const star = uniqueStar();
    // Two factory clients (same scope-admin, distinct tabs → distinct TreeSubscribers).
    const a = await loggedInFactory(star);
    const b = await loggedInFactory(star);

    // No explicit subscribeTree: the factory's registered orgTree listener opted
    // each client into auto-subscribing on connect, so the synth snapshot lands at
    // store.lmz.orgTree.value on both.
    await vi.waitFor(() => {
      expect((a.store.lmz.orgTree.value as { nodes?: Map<number, unknown> } | undefined)?.nodes).toBeInstanceOf(Map);
      expect((b.store.lmz.orgTree.value as { nodes?: Map<number, unknown> } | undefined)?.nodes).toBeInstanceOf(Map);
    });
    const beforeA = nodeLabels(a.store.lmz.orgTree.value).length;

    // A mutates the tree. No optimistic local write — A's own store updates only
    // via the broadcast echo (originator included).
    const slug = `team-${generateUuid().slice(0, 8)}`;
    await a.client.orgTree.createNode(ROOT_NODE_ID, slug, 'Engineering');

    // Both the originator (A) AND the observer (B) see the new node via broadcast.
    await vi.waitFor(() => {
      expect(nodeLabels(a.store.lmz.orgTree.value)).toContain('Engineering');
      expect(nodeLabels(b.store.lmz.orgTree.value)).toContain('Engineering');
    });
    expect(nodeLabels(a.store.lmz.orgTree.value).length).toBe(beforeA + 1);

    await a.dispose();
    await b.dispose();
  });
});
