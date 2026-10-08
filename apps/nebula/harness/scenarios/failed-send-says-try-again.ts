/**
 * **When the email provider refuses a sign-in mail, the person is told to try again.**
 *
 * A claim commits its account and only then sends the link, so a send that fails leaves the account
 * written and no mail coming. The answer used to be the Registry's catch-all, a 500 reading "An
 * unexpected error occurred", which the login screen shows as it stands. The answer is now
 * `502 email_send_failed`, "We couldn't send your sign-in email. Try again.", and trying again is
 * true: a retry writes a fresh link and sends it.
 *
 * The boot gives Resend a key it refuses, so every send in this run fails at the real provider with
 * a real 401. Nothing here stands in for the sender.
 *
 * Limbs, each isolated (`live-scenarios.md` — per limb):
 *
 *  1. **A first claim whose send fails answers 502 and says try again.** The stack logs the failed
 *     send with Resend's own refusal. *Reds if `#deliverMagicLink` stops catching the send: the
 *     catch-all answers 500.*
 *  2. **Trying again is a resume, and a resume whose send fails answers the same.** The same slug
 *     and address again answers the same 502, and a different address on that slug answers
 *     `slug_taken`, which shows the first claim committed. *Reds if the resume goes back to firing
 *     its send unawaited: it answers 200, "Check your email", for mail that never comes.*
 *  3. **A login request whose send fails answers 502 too.** It reaches the send over RPC, so the
 *     Worker turns the error back into its status. *Reds if the login handler stops reading the
 *     error's name and code: the router answers 500.*
 *
 * Local only: a deployed target sends with its own key, which `bootVars` cannot reach, so there
 * the scenario says so and stops. `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { uniqueTestEmail } from '@lumenize/email-test/client';
import type { DevStack } from '../lib/harness';
import { testSlug } from '../lib/test-scopes';
import { waitForDebugLines, type DebugLine } from '../lib/stdio';

export const needsContainer = false;
export const bootVars = { RESEND_API_KEY: 're_refused_by_design', DEBUG: 'nebula-auth.Registry.email' };

const TRY_AGAIN = "We couldn't send your sign-in email. Try again.";

export async function run(stack: DevStack): Promise<void> {
  if (process.env.HARNESS_TARGET_URL) {
    console.error('[failed-send-says-try-again] not observable on a deployed target: it sends with its own key');
    return;
  }
  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(`${stack.baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const universe = testSlug('send');
  const email = uniqueTestEmail();
  const claim = { slug: universe, appSlug: 'crm', email };

  // ── LIMB 1: a first claim whose send fails answers 502 and says try again ──────────────────────
  const first = await post('/auth/claim-universe', claim);
  assert.deepEqual(first, { status: 502, body: { error: 'email_send_failed', error_description: TRY_AGAIN } },
    'a claim whose send fails must say so and say try again');
  const isFailedSend = (l: DebugLine) => l.namespace === 'nebula-auth.Registry.email'
    && l.message === 'Magic-link send failed' && l.data.to === email;
  const lines = await waitForDebugLines(stack, (all) => all.some(isFailedSend), 'the failed send for the claim');
  assert.match(String(lines.find(isFailedSend)!.data.error), /Resend API error: 401/,
    "the failure must be Resend's own refusal, not a send that never left");
  console.error("  ✓ limb 1 — the first claim answered 502 email_send_failed, and the stack logged Resend's 401");

  // ── LIMB 2: trying again is a resume, and a resume whose send fails answers the same ───────────
  const again = await post('/auth/claim-universe', claim);
  assert.deepEqual(again, first, 'a resume whose send fails must answer as the first claim did');
  const stranger = await post('/auth/claim-universe', { ...claim, email: uniqueTestEmail() });
  assert.equal(stranger.status, 409, 'another address on the same slug must be refused, which shows the claim committed');
  assert.equal(stranger.body.error, 'slug_taken');
  console.error('  ✓ limb 2 — the retry answered the same 502, and another address got slug_taken');

  // ── LIMB 3: a login request whose send fails answers 502 too ───────────────────────────────────
  const login = await post('/auth/email-magic-link', { email });
  assert.deepEqual(login, { status: 502, body: { error: 'email_send_failed', error_description: TRY_AGAIN } },
    'a login request whose send fails must say so and say try again');
  console.error('  ✓ limb 3 — the login request answered 502 email_send_failed');
}
