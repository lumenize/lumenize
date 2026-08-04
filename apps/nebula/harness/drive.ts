/**
 * Live self-verification harness — Bash entry point.
 *
 *   npx tsx apps/nebula/harness/drive.ts [scenario]   # default: message-roundtrip
 *   HARNESS_DEBUG=1 npx tsx apps/nebula/harness/drive.ts   # stream wrangler-dev stdio
 *
 * Boots a fresh local `wrangler dev`, runs the named scenario against the *running* system,
 * tears the stack down, and **exits non-zero if any step fails** (the runnable gate the
 * `.claude/` skill wraps). One command: boot → identity → run scenario → inspect/assert →
 * wipe → report.
 *
 * @see tasks/archive/claude-live-verification.md
 */
import { bootDevStack, HAS_DOCKER } from './lib/harness';
import * as messageRoundtrip from './scenarios/message-roundtrip';
import * as superadminReach from './scenarios/superadmin-reach';
import * as studioChatReload from './scenarios/studio-chat-reload';
import * as turnstileCanary from './scenarios/turnstile-canary';
import * as impersonationExpiry from './scenarios/impersonation-expiry';
import * as impersonationLifecycle from './scenarios/impersonation-lifecycle';
import * as identityConvergence from './scenarios/identity-convergence';
import * as revokeIsTotal from './scenarios/revoke-is-total';
import * as profileTakeoverRefused from './scenarios/profile-takeover-refused';

/**
 * A runnable scenario. `needsContainer` defaults to TRUE — the historical behaviour, and the safe
 * default: a scenario that quietly declares `false` and then touches `ctx.container` fails at the
 * point of use rather than at the precheck. Declare `false` only when the scenario genuinely never
 * drives a build (auth, impersonation, resources, subscriptions), which then removes the Docker
 * requirement for that boot entirely.
 */
interface Scenario {
  run: (stack: Awaited<ReturnType<typeof bootDevStack>>) => Promise<void>;
  needsContainer?: boolean;
}

/** Registry of runnable scenarios (add new ones here — arbitrary, not a fixed test). */
const SCENARIOS: Record<string, Scenario> = {
  'message-roundtrip': messageRoundtrip,   // Phase 1 — API driver round-trip + negative control
  'superadmin-reach': superadminReach,     // Phase 3a B2-(i) — * admin bypass vs non-admin denied
  'studio-chat-reload': studioChatReload,  // Phase 2 — browser driver: login→chat→reload + capture
  'turnstile-canary': turnstileCanary,     // Turnstile ON (test secret) — gate + bypass + widget path
  'impersonation-expiry': impersonationExpiry, // impersonate() across a REAL token lapse (no Docker)
  'impersonation-lifecycle': impersonationLifecycle, // impersonate() end-to-end: identity → refusals → teardown
  'identity-convergence': identityConvergence, // one address, two real logins → ONE profileId (no fixture)
  'revoke-is-total': revokeIsTotal,            // two real sessions → a real 401 from a real server
  'profile-takeover-refused': profileTakeoverRefused, // manufactured scope authority buys nothing (no fixture)
};

async function main(): Promise<void> {
  const name = process.argv[2] ?? 'message-roundtrip';
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`[harness] unknown scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const needsContainer = scenario.needsContainer ?? true;
  if (needsContainer && !HAS_DOCKER) {
    console.error('[harness] Docker Desktop is not reachable — the DevContainer builds at boot. Start Docker and retry.');
    process.exitCode = 3;
    return;
  }

  console.error(needsContainer
    ? '[harness] booting a fresh local wrangler dev (cold DevContainer build can take a few minutes)…'
    : '[harness] booting a fresh local wrangler dev WITHOUT the DevContainer (no Docker needed)…');
  const stack = await bootDevStack({ withContainer: needsContainer });
  const t0 = Date.now();
  try {
    console.error(`[harness] booted at ${stack.baseUrl} — running scenario "${name}"…`);
    await scenario.run(stack);
    console.log(`✅ harness scenario "${name}" PASSED (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    console.error(`❌ harness scenario "${name}" FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  } finally {
    await stack.cleanup();
  }
}

main().catch((err) => {
  console.error('[harness] fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
