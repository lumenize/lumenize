/**
 * Turnstile canary — verify, against a REALLY-booted worker with Turnstile genuinely ON, that:
 *   1. the gate BLOCKS a normal request (403 turnstile) — i.e. today's SPA (no widget) would break;
 *   2. the authorized header **bypass** carries automation THROUGH (the path only unit-tested so far);
 *   3. a WRONG bypass token is still blocked (the token is validated, not mere header-presence);
 *   4. a request carrying a Turnstile token PASSES (the widget fix will work once the SPA sends one);
 *   5. the login path (`email-magic-link`) also blocks as-is — the confirmed UI blocker.
 *
 * Run with the always-passes Turnstile TEST secret injected for one boot:
 *   HARNESS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA \
 *     npx tsx apps/nebula/harness/drive.ts turnstile-canary
 *
 * ⚠️ **Every probe is POST-GATE-FAILING, and that is now load-bearing.** These used to hit
 * `discover`, which was unauthenticated and wrote nothing — the perfect canary target, and gone with
 * the enumeration oracle it was. Every surviving open row MINTS a scope or SENDS MAIL when it
 * succeeds, so a gate-PASS probe against one would leave real state behind on every run. Instead each
 * probe posts a slug the DO's own grammar rejects: it clears the gate (which is all probes 2 and 4
 * assert) and is then refused, so the canary claims nothing and sends nothing. Zero emails, zero
 * universes.
 *
 * Capable-of-failing: every probe asserts. If probe 1 doesn't block, the gate isn't on (the run is
 * missing HARNESS_TURNSTILE_SECRET) and the scenario fails loudly with that guidance.
 */
import assert from 'node:assert/strict';
import type { DevStack } from '../lib/harness';
import { readDevVar } from '../lib/harness';

const BYPASS_HEADER = 'x-lumenize-turnstile-bypass';
/** A Star-tier scope for the login-path probe; the gate runs before scope resolution, so any works. */
/**
 * A body that clears every EDGE check and is then refused by the Registry's own slug grammar.
 *
 * The gate is what these probes are about; the endpoint behind it is incidental, and must not act.
 */
const POST_GATE_FAILING = (email: string) => ({ slug: 'Not A Valid Slug', email });

interface ProbeResult {
  status: number;
  text: string;
}

/** True when the response is a Turnstile gate rejection (403 whose body names turnstile). */
function isTurnstileBlock(r: ProbeResult): boolean {
  return r.status === 403 && /turnstile/i.test(r.text);
}

/**
 * What a sweep must set for THIS scenario and no other — the gate has to be ON here and OFF
 * everywhere else, since every other scenario posts to these same open routes with no bypass token.
 *
 * ⚠️ Not a secret: `1x00000000000000000000AA` and its `…0AA` sibling are Cloudflare's PUBLISHED
 * always-passes test keys, which is what makes probe 4 able to exercise the real `siteverify` call
 * without a real widget. The account's actual secret never appears here.
 */
export const sweepEnv = { HARNESS_TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' };

export async function run(stack: DevStack): Promise<void> {
  const bypassToken = readDevVar('NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN');

  async function post(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<ProbeResult> {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text().catch(() => '') };
  }

  const email = 'canary@example.com';

  // ── 1. Gate ON: a plain request (what the current SPA sends — no token, no bypass) is BLOCKED ──
  const plain = await post('/auth/claim-universe', POST_GATE_FAILING(email));
  assert.ok(
    isTurnstileBlock(plain),
    `Probe 1 (gate ON): an open row with no token/bypass should 403-turnstile, got ${plain.status} ` +
      `"${plain.text.slice(0, 120)}". If this is a non-turnstile pass-through, the gate isn't on — ` +
      `run with HARNESS_TURNSTILE_SECRET=1x0000000000000000000000000000000AA.`,
  );
  console.error(`  ✓ probe 1 — gate ON, plain request BLOCKED (${plain.status})`);

  // ── 2. Bypass WORKS: the authorized header carries the request THROUGH the gate ──
  const bypassed = await post('/auth/claim-universe', POST_GATE_FAILING(email), { [BYPASS_HEADER]: bypassToken });
  assert.ok(
    !isTurnstileBlock(bypassed),
    `Probe 2 (bypass): an open row WITH the authorized bypass header must pass the gate, but was ` +
      `turnstile-blocked (${bypassed.status} "${bypassed.text.slice(0, 120)}").`,
  );
  console.error(`  ✓ probe 2 — authorized bypass PASSES the gate (${bypassed.status})`);

  // ── 3. WRONG bypass token is still BLOCKED (validated, not header-presence) ──
  const wrongBypass = await post('/auth/claim-universe', POST_GATE_FAILING(email), { [BYPASS_HEADER]: `${bypassToken}x` });
  assert.ok(
    isTurnstileBlock(wrongBypass),
    `Probe 3 (wrong token): a WRONG bypass token must still be blocked, got ${wrongBypass.status} ` +
      `"${wrongBypass.text.slice(0, 120)}" — the token is not being validated.`,
  );
  console.error(`  ✓ probe 3 — wrong bypass token REJECTED (${wrongBypass.status})`);

  // ── 4. Widget path: a request carrying a Turnstile token PASSES (test secret always-passes) ──
  //     Confirms the SPA fix (send `cf-turnstile-response`) will clear the gate. Real siteverify call.
  const widget = await post('/auth/claim-universe',
    { ...POST_GATE_FAILING(email), 'cf-turnstile-response': 'canary-dummy-token' });
  assert.ok(
    !isTurnstileBlock(widget),
    `Probe 4 (widget path): an open row carrying a Turnstile token should pass (the always-passes test ` +
      `secret verifies any token), but was blocked (${widget.status} "${widget.text.slice(0, 120)}").`,
  );
  console.error(`  ✓ probe 4 — widget token path PASSES the gate (${widget.status})`);

  // ── 5. Login path also blocks as-is: email-magic-link with no token → 403 at the gate, no email ──
  const login = await post('/auth/email-magic-link', { email });
  assert.ok(
    isTurnstileBlock(login),
    `Probe 5 (login break): email-magic-link with no token should 403-turnstile (the confirmed SPA ` +
      `blocker), got ${login.status} "${login.text.slice(0, 120)}".`,
  );
  console.error(`  ✓ probe 5 — login path (email-magic-link) BLOCKED as-is (${login.status})`);

  console.error(
    '  ── canary result: Turnstile gate ON works; bypass verified end-to-end on a real worker; ' +
      'wrong-token rejected; widget path will clear the gate; the open rows break until the SPA ' +
      'sends a token (the confirmed UI blocker).',
  );
}
