/**
 * **A refused subscribe reaches the tab at once, on either road a refusal takes.**
 *
 * Every subscribe a `NebulaClient` sends names a result handler, sent `onErrorOnly`, which hands a
 * refusal to the push handler a host-reported error uses. So the subscribe's promise rejects as soon
 * as the refusal arrives, rather than when its 30 s timer gives up. A client subscribes only at its
 * own token's `aud`, which passage always admits, so each limb drives the refusal a user-developer
 * meets in practice: a client whose `resourceHostBinding` names the wrong binding.
 *
 * Two limbs, both run, with the verdict at the end (`live-scenarios.md`):
 *  1. **`'PROFILE'`: refused at the early ack.** The Profile refuses to run under the galaxy's
 *     name, so the host node hands the refusal straight back.
 *     Mutation: drop the subscribe's handler, and the refusal arrives only at the 30 s timer.
 *  2. **`'UNIVERSE'`: refused after the ack.** The Universe admits the call, then finds no member
 *     named `resources`, and the refusal rides the fire-back.
 *     Mutation: the same, on the road after the ack.
 *
 * Each limb is its own positive control for the other: the same subscribe, the same login, a
 * different road. A real login throughout (ADR-009 rung 1): the run's shared app's owner, signed
 * in by email. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/resources/client';
import { CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { readDevVar, scopeUrlOf } from '../lib/harness';
import { provisionAndLogin } from '../../test/lib/email-login';
import { sharedApp } from '../lib/shared-app';

export const needsContainer = false;

/** Well inside the 30 s timer, so a refusal that waited for it fails the limb. */
const PROMPT_MS = 5_000;

export async function run(stack: DevStack): Promise<void> {
  const testToken = readDevVar('TEST_TOKEN');
  const origin = stack.baseUrl.replace(/\/$/, '');
  const app = await sharedApp(stack, testToken);
  const session = await provisionAndLogin({ baseUrl: origin, scope: app.galaxy, email: app.ownerEmail, testToken });
  const failures: string[] = [];

  /** A tab on the galaxy's host whose resource ops go to `resourceHostBinding`. */
  async function tabWithHost(resourceHostBinding: string): Promise<NebulaClient> {
    const ctx = new Browser().context(scopeUrlOf(stack, app.galaxy));
    const client = new NebulaClient({
      baseUrl: scopeUrlOf(stack, app.galaxy),
      platformOrigin: stack.baseUrl,
      ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
      resourceHostBinding,
      accessToken: session.accessToken,
      instanceName: `${session.sub}.${crypto.randomUUID().slice(0, 8)}`,
      fetch: ctx.fetch,
      sessionStorage: ctx.sessionStorage,
      BroadcastChannel: ctx.BroadcastChannel,
    });
    const deadline = Date.now() + 30_000;
    while (client.connectionState !== 'connected') {
      assert.ok(Date.now() < deadline, `the ${resourceHostBinding} tab never connected (state=${client.connectionState})`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return client;
  }

  /** Subscribe, and report how the subscribe settled and how long it took. */
  async function subscribeOutcome(client: NebulaClient): Promise<{ refusal: string | null; ms: number }> {
    const started = Date.now();
    const subscription = client.resources.subscribe('Chat', crypto.randomUUID());
    try {
      await subscription.snapshot;
      return { refusal: null, ms: Date.now() - started };
    } catch (e) {
      return { refusal: e instanceof Error ? e.message : String(e), ms: Date.now() - started };
    } finally {
      subscription[Symbol.dispose]();
    }
  }

  const limbs: Array<{ n: number; binding: string; road: string; expected: RegExp }> = [
    { n: 1, binding: 'PROFILE', road: 'at the early ack',
      expected: new RegExp(`^"${app.galaxy.replace(/\./g, '\\.')}" parses as a scope, and an UnscopedMeshDO never runs under a scope's name`) },
    { n: 2, binding: 'UNIVERSE', road: 'after the ack',
      expected: /^No member named 'resources' exists on this node/ },
  ];
  for (const limb of limbs) {
    const client = await tabWithHost(limb.binding);
    try {
      const { refusal, ms } = await subscribeOutcome(client);
      if (refusal !== null && limb.expected.test(refusal) && ms < PROMPT_MS) {
        console.log(`  ✓ limb ${limb.n} — a subscribe refused ${limb.road} rejects in ${ms} ms`);
      } else {
        const got = `${refusal ?? '(resolved)'} after ${ms} ms`;
        console.log(`  ✗ limb ${limb.n} — got ${got}`);
        failures.push(`limb ${limb.n}: a subscribe through '${limb.binding}' should be refused ${limb.road} within ${PROMPT_MS} ms. Got: ${got}`);
      }
    } finally {
      client[Symbol.dispose]();
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
}
