/**
 * Live self-verification harness — Bash entry point.
 *
 *   npx tsx apps/nebula/harness/drive.ts [scenario]   # default: message-roundtrip
 *   npx tsx apps/nebula/harness/drive.ts all          # sweep EVERY scenario, one boot each
 *   npx tsx apps/nebula/harness/drive.ts all --fast   # …skipping the ones that need Docker
 *   HARNESS_DEBUG=1 npx tsx apps/nebula/harness/drive.ts   # stream wrangler-dev stdio
 *
 * ⚠️ **Run the sweep after touching anything a scenario you did not write depends on** — a login
 * or consent semantic, `test/lib/email-login.ts`, a shared Studio screen. Nothing else will tell
 * you: `/live` is not in CI, so a broken scenario stays green-looking until someone runs it.
 *
 * Boots a fresh local `wrangler dev`, runs the named scenario against the *running* system,
 * tears the stack down, and **exits non-zero if any step fails** (the runnable gate the
 * `.claude/` skill wraps). One command: boot → identity → run scenario → inspect/assert →
 * wipe → report.
 *
 * @see tasks/archive/claude-live-verification.md
 */
import { bootDevStack, HAS_DOCKER, readDevVar } from './lib/harness';
import * as messageRoundtrip from './scenarios/message-roundtrip';
import * as downwardDominion from './scenarios/downward-dominion';
import * as superuserEndToEnd from './scenarios/superuser-end-to-end';
import * as passageNotDominion from './scenarios/passage-not-dominion';
import * as studioChatReload from './scenarios/studio-chat-reload';
import * as turnstileCanary from './scenarios/turnstile-canary';
import * as impersonationExpiry from './scenarios/impersonation-expiry';
import * as impersonationLifecycle from './scenarios/impersonation-lifecycle';
import * as identityConvergence from './scenarios/identity-convergence';
import * as revokeIsTotal from './scenarios/revoke-is-total';
import * as profileTakeoverRefused from './scenarios/profile-takeover-refused';
import * as studioCodegenRest from './scenarios/studio-codegen-rest';
import * as upwardInviteRefused from './scenarios/upward-invite-refused';
import * as inviteRoundtrip from './scenarios/invite-roundtrip';
import * as nodeInviteRoundtrip from './scenarios/node-invite-roundtrip';
import * as buildBox from './scenarios/build-box';
import * as fourPartyChat from './scenarios/four-party-chat';
import * as loginTwoMemberships from './scenarios/login-two-memberships';
import * as signupOneEmail from './scenarios/signup-one-email';
import * as inviteConsent from './scenarios/invite-consent';
import * as superuserFrontDoor from './scenarios/superuser-front-door';
import * as authPagesRender from './scenarios/auth-pages-render';
import * as studioSignedOutLanding from './scenarios/studio-signed-out-landing';
import * as studioOverlaysByUrl from './scenarios/studio-overlays-by-url';
import * as signupToFirstApp from './scenarios/signup-to-first-app';
import * as firstAppBuilt from './scenarios/first-app-built';

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
  /**
   * `--var NAME:VALUE` overrides applied to THIS boot only, for a scenario whose subject is server
   * configuration the identity path reads. Never a `.dev.vars` mutation — it auto-reverts per boot.
   */
  bootVars?: Record<string, string>;
  /**
   * Process env this scenario needs, applied ONLY to its own child in a sweep (`drive.ts all`).
   *
   * ⚠️ **Per-scenario rather than exported to the shell, because these are mutually exclusive.**
   * `turnstile-canary` needs the gate ON; every other scenario posts to those same open routes
   * without a bypass token and gets a 403 if it is. Setting it globally for a sweep therefore
   * fails everything else — as it did, on the first hand-run of one.
   */
  sweepEnv?: Record<string, string>;
}

/** Registry of runnable scenarios (add new ones here — arbitrary, not a fixed test). */
const SCENARIOS: Record<string, Scenario> = {
  'message-roundtrip': messageRoundtrip,   // Phase 1 — API driver round-trip + negative control
  'downward-dominion': downwardDominion,        // real-login covering admin acts in a Star beneath; non-admin denied
  'superuser-end-to-end': superuserEndToEnd,    // real bootstrap login: verify → refresh → enumerate → Profile gate
  'passage-not-dominion': passageNotDominion,   // upward read RETURNS while upward write REFUSES; sibling Star refused
  'studio-chat-reload': studioChatReload,  // Phase 2 — browser driver: login→chat→reload + capture
  'turnstile-canary': turnstileCanary,     // Turnstile ON (test secret) — gate + bypass + widget path
  'impersonation-expiry': impersonationExpiry, // impersonate() across a REAL token lapse (no Docker)
  'impersonation-lifecycle': impersonationLifecycle, // impersonate() end-to-end: identity → refusals → teardown
  'identity-convergence': identityConvergence, // one address, two real logins → ONE profileId (no fixture)
  'revoke-is-total': revokeIsTotal,            // two real sessions → a real 401 from a real server
  'profile-takeover-refused': profileTakeoverRefused, // manufactured scope dominion buys nothing (no fixture)
  'studio-codegen-rest': { ...studioCodegenRest, needsContainer: false }, // one real codegen turn over the Workers-AI REST transport — container-TOLERANT: a container-failed build step is a reported outcome, not a scenario failure
  'upward-invite-refused': upwardInviteRefused, // a real star admin's upward invite rejected by the facade's dominion message (no Docker)
  'invite-roundtrip': inviteRoundtrip,          // client.invite → facade → real email → click → founder stamp (no Docker)
  'node-invite-roundtrip': nodeInviteRoundtrip, // Star.invite → both planes → real email → invitee acts at the node (no Docker)
  'build-box': buildBox,                   // ephemeral build drive: per-step BuildReport, sequential + overlap + failed-bundle + serve readback (Docker)
  'four-party-chat': fourPartyChat,        // Phase 4 HEADLINE — owner + coach + invited collaborator + Nebula, one thread, attributed (no Docker)
  // ── prove-then-choose: the login re-order, driven end to end on real mail (no Docker) ──────────
  'login-two-memberships': loginTwoMemberships, // one email → a session per membership; the multi-membership dead end is gone
  'signup-one-email': signupOneEmail,           // both newbie arms cost exactly ONE email — asserted by counting real mail
  'invite-consent': inviteConsent,              // an invitation is an OFFER: Home, modal, consent — pre-accept + decline limbs
  'superuser-front-door': superuserFrontDoor,   // the superuser logs in like anyone else and consents to the platform root
  'auth-pages-render': authPagesRender,         // the auth screens RENDER — content, never a status code (browser)
  'studio-signed-out-landing': studioSignedOutLanding, // signed out, Studio is ONE landing — no chat rail; Sign in is the auth SPA's door (browser)
  'studio-overlays-by-url': studioOverlaysByUrl,       // the profile editor, manage panel and create form open ONLY by URL; Back closes (browser)
  // ── the browser lane for a stranger's first hour: signup → first app → first build ──────────
  'signup-to-first-app': signupToFirstApp,       // the whole clean signup, driven by CLICKING — the app is created through the UI, never by API (no Docker)
  'first-app-built': firstAppBuilt,              // a prompt typed in the rendered composer produces a built app in the preview (Docker)
};

/**
 * Run EVERY registered scenario, one fresh boot each, and report a table.
 *
 * ⚠️ **This exists because the registry is a suite that nothing runs.** `/live` is not in CI, so a
 * change to a shared login semantic silently breaks the scenarios someone else wrote, and the
 * breakage surfaces whenever the next person happens to run one — which for a scenario nobody has
 * touched in a month is never. Measured 2026-09-01: a build shipped its own five scenarios green
 * while breaking NINE of the seventeen that came before it, none of which any vitest suite could
 * see. One command is the difference between finding that in four minutes and not finding it.
 *
 * A CHILD PROCESS per scenario, deliberately: each needs its own `wrangler dev` with its own
 * `bootVars`, `sweepEnv` values are mutually exclusive (see `Scenario.sweepEnv`), and a scenario
 * that leaks a handle or wedges a workerd cannot then take the rest of the sweep with it.
 */
async function sweep(fast: boolean): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const names = Object.keys(SCENARIOS)
    .filter((n) => !fast || (SCENARIOS[n].needsContainer ?? true) === false);
  console.error(`[harness] sweeping ${names.length} scenario(s)${fast ? ' (container-free only)' : ''}…\n`);

  const results: Array<{ name: string; ok: boolean; secs: string; detail: string }> = [];
  for (const name of names) {
    const t0 = Date.now();
    // A stray workerd from a previous scenario starves the next one's boot and its alarms, which
    // reads as a flaky scenario rather than as contention (`testing.md`).
    spawnSync('pkill', ['-9', '-f', 'workerd'], { stdio: 'ignore' });
    // Re-exec the DOCUMENTED command rather than `node <this file>`: this is a `.ts` entry point,
    // so a bare node spawn exits instantly with a loader error — which the sweep would then report
    // as seventeen failing scenarios in 0.1 s each. (It did, on the first run.)
    const child = spawnSync(
      'npx',
      ['tsx', process.argv[1]!, name],
      {
        env: { ...process.env, ...SCENARIOS[name].sweepEnv },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    const ok = child.status === 0;
    const detail = ok ? '' : (/^(?:AssertionError|\w*Error):.*$/m.exec(out)?.[0] ?? '(see output)').slice(0, 120);
    results.push({ name, ok, secs: ((Date.now() - t0) / 1000).toFixed(1), detail });
    console.error(`${ok ? '✅' : '❌'} ${name.padEnd(26)} ${results.at(-1)!.secs}s ${detail}`);
    if (!ok && process.env.HARNESS_DEBUG) console.error(out);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[harness] ${results.length - failed.length}/${results.length} passed`);
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}`);
  if (failed.length > 0) process.exitCode = 1;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith('-')) ?? 'message-roundtrip';
  if (name === 'all') return sweep(argv.includes('--fast'));

  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`[harness] unknown scenario "${name}". Known: all, ${Object.keys(SCENARIOS).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  const needsContainer = scenario.needsContainer ?? true;

  // DEPLOYED target — run the very same scenarios against a real Worker instead of a
  // local boot. Both venues run the FULL contract, including the mount-dependent limbs:
  // local `wrangler dev` never passes `/dev/fuse` to the container it starts (verified
  // by `docker inspect`: Devices=null, CapAdd=null), so `computerd` materializes the
  // synced /workspace subtree onto the container's real disk instead of kernel-mounting
  // it — functionally equivalent for a build (corrected 2026-08-29; "a build can only
  // fail locally" was the root-level-seeding bug, not the fallback). A deployed run
  // still earns its keep as the real-FUSE + real-infra check.
  // ⚠️ The target must carry the SAME JWT secrets as `.dev.vars`
  // — a scenario that mints (rung 3) signs with the local key, and every rung-1 login
  // rides the deployed worker's own issuer.
  //   npm run deploy:test && HARNESS_TARGET_URL=<url> npx tsx apps/nebula/harness/drive.ts build-box
  const target = process.env.HARNESS_TARGET_URL;
  if (!target && needsContainer && !HAS_DOCKER) {
    console.error('[harness] Docker Desktop is not reachable — the build-box image builds at boot. Start Docker and retry.');
    process.exitCode = 3;
    return;
  }

  if (target) {
    console.error(`[harness] DEPLOYED target — no local boot: ${target}`);
  } else {
    console.error(needsContainer
      ? '[harness] booting a fresh local wrangler dev (cold build-box image build can take a few minutes)…'
      : '[harness] booting a fresh local wrangler dev WITHOUT the build box (no Docker needed)…');
  }
  const stack = target
    ? {
        baseUrl: target.replace(/\/$/, ''),
        signingKey: readDevVar('JWT_PRIVATE_KEY_BLUE'),
        activeKey: 'BLUE' as const,
        // Nothing local was started, so there is nothing to tear down. ⚠️ State on a
        // deployed target SURVIVES the run — scenarios provision fresh scopes per run,
        // which is what keeps repeat runs from colliding.
        cleanup: async () => {},
      }
    : await bootDevStack({ withContainer: needsContainer, vars: scenario.bootVars });
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

main()
  .catch((err) => {
    console.error('[harness] fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    // Hard-exit after the verdict + teardown: a scenario that throws MID-FLIGHT leaves whatever it
    // had open (client WebSockets, waiters) still holding the event loop, so the process prints its
    // failure and then hangs — indistinguishable from a slow boot to the caller. The verdict is
    // already printed and the stack cleaned up; nothing after this is worth waiting for.
    process.exit(process.exitCode ?? 0);
  });
