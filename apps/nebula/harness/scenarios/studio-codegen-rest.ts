/**
 * Drive ONE real codegen turn through the shipping Workers-AI REST transport — via the
 * POST-COLLAPSE trigger: `postUserMessage` commits the human `Message`, the Galaxy's
 * commit hook starts the turn (discriminator → generation under the poster's own
 * authority), and completion is OBSERVED ON THE `Message` SUBSCRIPTION — the same way
 * the product observes it, with no reply channel at all.
 *
 * The subject is `Galaxy#callModelRest` — specifically that gateway routing is a
 * `cf-aig-gateway-id` header on the ordinary `/ai/run/{model}` URL rather than a second
 * origin, so there is one URL for every configuration. A wrong URL, a stale envelope shape,
 * or an auth regression all land here as a failed turn.
 *
 * ⚠️ **A broken model call HANGS rather than rejecting**, which is why the deadline below
 * is the real assertion and not a nicety: the triggered turn runs detached server-side, so
 * a throwing transport just means NO agent `Message` ever lands — silence, not an error.
 * Bounding the subscription wait converts that silence into a loud failure. (Same trap
 * `live.md` warns about: a hang reads as a slow boot.)
 *
 * ⚠️ **Deliberately asserts TRANSPORT, not model quality.** Whether the model wrote good Vue
 * is a different question with a different failure mode. What is asserted is that a
 * well-formed agent reply landed durably, `replyTo`-linked to the posted message.
 * Generation quality is reported, not gated.
 *
 * Requires the `env.AI`-free REST lane: `WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in
 * `.dev.vars` (`runModel` prefers REST whenever the token is present). `CF_AI_GATEWAY` is
 * OPTIONAL and unset by default — see `#callModelRest`'s JSDoc for why that default is a
 * decision rather than an omission.
 */
import assert from 'node:assert/strict';
import { DEFAULT_CHAT_ID } from '@lumenize/nebula/client';
import type { Snapshot } from '@lumenize/nebula/client';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';

/** A galaxy scope of this scenario's own (never shared — codegen writes source). */
const SCOPE = 'claude.codegen';

/** A cold model turn (discriminator + generation) lives inside this budget. */
const TURN_TIMEOUT_MS = 240_000;

export async function run(stack: DevStack): Promise<void> {
  // Fail on the PRECONDITION rather than silently proving the binding lane instead. Without a
  // token `runModel` falls through to `env.AI`, which would pass this scenario green while
  // exercising none of the code it exists to cover.
  const optionalDevVar = (name: string): string | undefined => {
    try { return readDevVar(name); } catch { return undefined; }
  };
  const token = optionalDevVar('WORKERS_AI_TOKEN');
  const account = optionalDevVar('CLOUDFLARE_ACCOUNT_ID');
  assert.ok(token && account,
    'this scenario covers the REST lane — WORKERS_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID must be in .dev.vars');
  const gateway = optionalDevVar('CF_AI_GATEWAY');
  console.error(`[studio-codegen-rest] gateway routing: ${gateway ? `cf-aig-gateway-id: ${gateway}` : 'off (no CF_AI_GATEWAY)'}`);

  const driver = await connectDriver(stack, { scope: SCOPE });
  try {
    // Subscribe FIRST (the product's shape), then post — the reply arrives on the query.
    using sub = driver.client.resources.subscribeQuery({
      queryType: 'parentChild', typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID,
    });
    await sub.ready;

    const t0 = Date.now();
    const userMessageId = await driver.client.postUserMessage(
      'Add a button labelled Ping that appends the word pong to a list.',
    );

    // The completion observation: a SECOND Message appears whose replyTo is the posted id.
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    let agent: Snapshot | undefined;
    while (Date.now() < deadline && !agent) {
      for (const id of sub.resourceIds) {
        if (id === userMessageId) continue;
        const snap = await driver.client.resources.read('Message', id) as Snapshot | null;
        if (snap && (snap.value as { replyTo?: string }).replyTo === userMessageId) { agent = snap; break; }
      }
      if (!agent) await new Promise((r) => setTimeout(r, 2000));
    }
    assert.ok(agent,
      `no agent reply landed within ${TURN_TIMEOUT_MS / 1000}s — the triggered turn runs detached, ` +
      `so a broken REST transport is SILENCE here, and this deadline is what makes it loud`);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // The transport assertions: a real, well-formed durable reply.
    const v = agent.value as { content?: string; thought?: string; status?: string };
    assert.ok((v.content ?? '').length > 0, 'agent reply must carry non-empty content');
    assert.equal(v.status, 'complete', `agent reply status should be complete, got ${v.status}`);
    assert.ok((v.thought ?? '').length > 0,
      'thought must be non-empty — it is assembled from the parsed model turn, so an empty one means ' +
      'nothing came back from the model even though a Message landed');

    console.error(`[studio-codegen-rest] turn completed in ${elapsed}s`);
    console.error(`[studio-codegen-rest] reply: ${v.content}`);
    // Reported, NOT asserted — model quality is a separate failure mode (see the header).
    console.error(`[studio-codegen-rest] thought (${(v.thought ?? '').length} chars): ${(v.thought ?? '').slice(0, 400)}`);
  } finally {
    driver.wipe();
    driver.dispose();
  }
}
