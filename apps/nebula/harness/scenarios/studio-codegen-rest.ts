/**
 * Drive ONE real codegen turn through the shipping Workers-AI REST transport.
 *
 * The subject is `DevStudio#callModelRest` — specifically that gateway routing is now a
 * `cf-aig-gateway-id` header on the ordinary `/ai/run/{model}` URL rather than a second
 * origin, so there is one URL for every configuration. A wrong URL, a stale envelope shape,
 * or an auth regression all land here as a failed turn.
 *
 * ⚠️ **A broken model call HANGS rather than rejecting**, which is why the timeout below is
 * the real assertion and not a nicety. `client.chat()` fires one-way at DevStudio and settles
 * on a *fire-back*; `runCodegenLoop` does not wrap `deps.callModel` in a try/catch, so a
 * throwing REST call unwinds out of `DevStudio.chat` before it ever calls back and the
 * client's Promise simply never settles. Racing it against a deadline converts that silence
 * into a loud failure. (Same trap `live.md` warns about: a hang reads as a slow boot.)
 *
 * ⚠️ **Deliberately asserts TRANSPORT, not model quality.** Whether the model wrote good Vue
 * is a different question with a different failure mode; coupling this scenario to it would
 * make an unrelated model regression look like a transport break. What is asserted is that a
 * well-formed turn came back over the wire. Generation quality is reported, not gated.
 *
 * Requires the `env.AI`-free REST lane: `WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in
 * `.dev.vars` (`callModel` prefers REST whenever the token is present). `CF_AI_GATEWAY` is
 * OPTIONAL and unset by default — see `#callModelRest`'s JSDoc for why that default is a
 * decision rather than an omission.
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';

/** A `.dev` star scope of this scenario's own (never shared — codegen writes source). */
const SCOPE = 'claude.codegen.dev';

/** The container build + a cold model turn both live inside this budget. */
const TURN_TIMEOUT_MS = 240_000;

export async function run(stack: DevStack): Promise<void> {
  // Fail on the PRECONDITION rather than silently proving the binding lane instead. Without a
  // token `callModel` falls through to `env.AI`, which would pass this scenario green while
  // exercising none of the code it exists to cover.
  //
  // `readDevVar` throws on a missing name — right for a secret, wrong for a var whose ABSENCE is
  // the documented default, so `CF_AI_GATEWAY` is read through the softening wrapper and the two
  // genuinely-required ones keep an assertion that says why they are required.
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
    const t0 = Date.now();
    const result = await Promise.race([
      driver.client.chat('Add a button labelled Ping that appends the word pong to a list.'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          `codegen turn did not settle in ${TURN_TIMEOUT_MS / 1000}s — a throwing callModel unwinds ` +
          `out of DevStudio.chat without firing back, so this is what a broken REST transport looks like`,
        )), TURN_TIMEOUT_MS).unref?.(),
      ),
    ]);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // The transport assertions: a real turn came back over the wire, well-formed.
    assert.equal(typeof result.reply, 'string', 'turn must carry a reply');
    assert.ok(result.reply.length > 0, 'reply must be non-empty');
    assert.ok(result.thought.length > 0,
      'thought must be non-empty — it is assembled from the parsed model turn, so an empty one means ' +
      'nothing came back from the model even though the call resolved');

    console.error(`[studio-codegen-rest] turn settled in ${elapsed}s`);
    console.error(`[studio-codegen-rest] reply: ${result.reply}`);
    // Reported, NOT asserted — model quality is a separate failure mode (see the header).
    console.error(`[studio-codegen-rest] thought (${result.thought.length} chars): ${result.thought.slice(0, 400)}`);
  } finally {
    driver.wipe();
    driver.dispose();
  }
}
