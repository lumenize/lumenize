/**
 * An app with no applied ontology is still an app.
 *
 * The serving layer injects the version the Galaxy has **applied**, and `applyOntology` is the
 * explicit dev Apply — so a freshly generated app has no version at all, and a "counter with an
 * increment button" never needs one. Until 2026-09-25 `createNebulaClient` refused to construct
 * without one, which meant that app could not render: the Studio preview served its shell and sat
 * on `<div id="app"></div>` with a mount-time throw as the only trace.
 *
 * The version is now required by the RESOURCE OPS rather than by construction. This file pins both
 * halves of that split — the client boots, and the resource plane refuses by name.
 */
import { describe, it, expect, vi } from 'vitest';
import { Browser } from '@lumenize/testing';
import { ROOT_NODE_ID, isNoOntologyInstalledError } from '@lumenize/nebula';
import type { TransactionResult } from '@lumenize/nebula';
import { adminClientAt } from '../../test-helpers';
import { NebulaClientTest } from './index';

const ONTOLOGY_VERSION = 'v1';
const TEST_TYPES = `interface TestResource { title: string; }`;

function uniqueStar(): string {
  return `acme-${crypto.randomUUID().slice(0, 8)}.app.tenant-a`;
}

/** A client whose config carries NO ontologyVersion — what the shell injects before any Apply. */
async function versionlessClientAt(star: string) {
  const { client } = await adminClientAt(
    NebulaClientTest, new Browser(), star, star, 'admin@example.com', ONTOLOGY_VERSION,
    // `extraConfig` spreads last, so this overrides the positional default with nothing — the
    // shape `readInjectedScope()` produces when `#appliedHead()` is empty and the meta omits it.
    { ontologyVersion: undefined },
  );
  return client;
}

describe('a client with no ontology version', () => {
  it('BOOTS and connects — the whole point', async () => {
    // `adminClientAt` waits for `connectionState === 'connected'`, so reaching this line already
    // proves it; asserting anyway so the failure names the property rather than timing out in a
    // helper. Under the old rule the constructor threw and this never got a connection at all.
    const client = await versionlessClientAt(uniqueStar());
    expect(client.connectionState).toBe('connected');
    expect(client.claims?.sub, 'a versionless client still authenticates').toBeTruthy();
    client[Symbol.dispose]();
  });

  it('refuses a resource op BY NAME, without touching client state', async () => {
    const client = await versionlessClientAt(uniqueStar());

    // Synchronous, and before any bookkeeping — `#subscribeResource` resolves the version ahead of
    // the registry write, so a refused subscribe leaves no entry and no armed abandon timer.
    let thrown: unknown;
    try {
      client.resources.subscribe('TestResource', crypto.randomUUID());
    } catch (err) {
      thrown = err;
    }
    expect(isNoOntologyInstalledError(thrown), `expected NoOntologyInstalledError, got ${thrown}`).toBe(true);
    expect((thrown as { operation: string }).operation).toBe('subscribe');
    expect((thrown as Error).message).toMatch(/Run Apply in Studio/);

    client[Symbol.dispose]();
  });

  it('POSITIVE CONTROL: the same drive with a version subscribes normally', async () => {
    // Without this, the refusal above would pass just as well if the fixture could never subscribe.
    const star = uniqueStar();
    const { client } = await adminClientAt(
      NebulaClientTest, new Browser(), star, star, 'admin@example.com', ONTOLOGY_VERSION,
    );
    client.callStarInstallOntology(star, { version: ONTOLOGY_VERSION, types: TEST_TYPES });
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });

    const resourceId = crypto.randomUUID();
    client.resetResults();
    client.callStarTransaction(star, ONTOLOGY_VERSION, {
      [resourceId]: { op: 'create', typeName: 'TestResource', nodeId: ROOT_NODE_ID, value: { title: 'Present' } },
    });
    await vi.waitFor(() => { expect(client.callCompleted).toBe(true); });
    expect((client.lastResult as TransactionResult)?.ok, client.lastError).toBe(true);

    const snap = await client.resources.subscribe('TestResource', resourceId).snapshot;
    expect(snap!.value.title).toBe('Present');

    client[Symbol.dispose]();
  });
});
