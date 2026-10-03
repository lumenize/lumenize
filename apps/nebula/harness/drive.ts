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
import { bootDevStack, HAS_DOCKER, readDevVar, type DevStack } from './lib/harness';
import { hostOrigin } from '@lumenize/nebula-auth/claims';
import { cloudflareCertificateApi } from '../src/certificate';
import { sweepStaleTestPacks } from './lib/test-scopes';
import { installLocalhostLookup } from './lib/localhost-lookup';
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
import * as broadcast120Subscribers from './scenarios/broadcast-120-subscribers';
import * as studioGuidanceLoop from './scenarios/studio-guidance-loop';
import * as meshEntryReach from './scenarios/mesh-entry-reach';
import * as reaperVictimIsTheAddress from './scenarios/reaper-victim-is-the-address';
import * as gatewayStampsTheChain from './scenarios/gateway-stamps-the-chain';
import * as displayNamesReachSubscribers from './scenarios/display-names-reach-subscribers';
import * as starServesCurrentOntology from './scenarios/star-serves-current-ontology';
import * as grantRevealsDenied from './scenarios/grant-reveals-denied';
import * as clientSenderPassage from './scenarios/client-sender-passage';
import * as gatewayOneBinding from './scenarios/gateway-one-binding';
import * as scopeTeardown from './scenarios/scope-teardown';
import * as galaxyCap from './scenarios/galaxy-cap';
import * as claimLifecycle from './scenarios/claim-lifecycle';
import * as refreshReadsTheHost from './scenarios/refresh-reads-the-host';
import * as linksSignNobodyIn from './scenarios/links-sign-nobody-in';
import * as linksSignInOnce from './scenarios/links-sign-in-once';
import * as invitesLandOnTheirHost from './scenarios/invites-land-on-their-host';
import * as logoutEndsEveryHost from './scenarios/logout-ends-every-host';
import * as hostsAndFrames from './scenarios/hosts-and-frames';
import * as devTabFrame from './scenarios/dev-tab-frame';
import * as sessionSurvivesTokenLapse from './scenarios/session-survives-token-lapse';
import * as homeListsEveryProfile from './scenarios/home-lists-every-profile';
import * as logoutEverywhere from './scenarios/logout-everywhere';
import * as studioAppSettings from './scenarios/studio-app-settings';
import * as hostRule from './scenarios/host-rule';
import * as personaHost from './scenarios/persona-host';
import * as certificateWake from './scenarios/certificate-wake';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with deploy-test.sh.
import { TEST_ORIGIN } from '../scripts/test-deploy-config.mjs';

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
  /**
   * PARKED: a one-line reason this scenario is not run by the sweep. A red-first limb written
   * before its fix exists lands with one of these, and the phase that closes the hole removes it.
   *
   * ⚠️ **A parked scenario is REPORTED, never omitted.** `SCENARIOS` is the registry the sweep
   * reads, so a limb held back by simply not registering it is invisible — nothing prints, nothing
   * counts, and the only record that it was meant to exist is a task file that archives. The sweep
   * therefore prints every parked scenario with its reason and counts it apart from pass and fail.
   *
   * A DIRECT run (`drive.ts <name>`) still RUNS it, loudly. That is the whole point of parking
   * rather than deleting: the phase that wrote it watches it go red, and the phase that fixes the
   * hole watches it go green, both before the flag comes off.
   */
  skip?: string;
}

/** Registry of runnable scenarios (add new ones here — arbitrary, not a fixed test). */
const SCENARIOS: Record<string, Scenario> = {
  'message-roundtrip': messageRoundtrip,   // API driver round-trip + negative control
  'downward-dominion': downwardDominion,        // real-login covering admin acts in a Star beneath; non-admin denied
  'superuser-end-to-end': superuserEndToEnd,    // real bootstrap login: verify → refresh → enumerate → Profile gate
  'passage-not-dominion': passageNotDominion,   // upward read RETURNS while upward write REFUSES; sibling Star refused
  'studio-chat-reload': studioChatReload,  // browser driver: login→chat→reload + capture
  'turnstile-canary': turnstileCanary,     // Turnstile ON (test secret) — gate + bypass + widget path
  'impersonation-expiry': impersonationExpiry, // impersonate() across a REAL token lapse (no Docker)
  'impersonation-lifecycle': impersonationLifecycle, // impersonate() end-to-end: identity → refusals → teardown
  'identity-convergence': identityConvergence, // one address, two real logins → ONE profileId (no fixture)
  'revoke-is-total': revokeIsTotal,            // two real sessions → a real 401 from a real server
  'profile-takeover-refused': profileTakeoverRefused, // manufactured scope dominion buys nothing (no fixture)
  'studio-codegen-rest': { ...studioCodegenRest, needsContainer: false }, // one real codegen turn over the Workers-AI REST transport — container-TOLERANT: a container-failed build step is a reported outcome, not a scenario failure
  'upward-invite-refused': upwardInviteRefused, // a real star admin's upward invite rejected by the facade's dominion message (no Docker)
  'invite-roundtrip': inviteRoundtrip,          // client.invite → facade → real email → click → acts through the bypass (no Docker)
  'node-invite-roundtrip': nodeInviteRoundtrip, // Star.resources.invite → both planes → real email → invitee acts at the node (no Docker)
  'build-box': buildBox,                   // ephemeral build drive: per-step BuildReport, sequential + overlap + failed-bundle + serve readback (Docker)
  'four-party-chat': fourPartyChat,        // HEADLINE — owner + coach + invited collaborator + Nebula, one thread, attributed (no Docker)
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
  'broadcast-120-subscribers': broadcast120Subscribers, // one commit to 120 subscribers on one query all lands — the ONLY test anywhere past a hundred targets (no Docker)
  // ── the guidance tree: the MODEL in the loop, observed — limbs reported, never gated ───────
  'studio-guidance-loop': studioGuidanceLoop,   // a stated convention lands in AGENTS.md and holds; a data-bound request uses resources; skills activate (no Docker; REST lane; ~10 real turns)
  // ── what a logged-in browser session reaches past `@mesh` — red until the executor closes it ──
  'mesh-entry-reach': meshEntryReach,           // every chain a remote caller must not run, refused past a real gate (no Docker)
  'reaper-victim-is-the-address': reaperVictimIsTheAddress,  // a forged reply reaps only its author; a real disconnect still reaps (no Docker)
  'gateway-stamps-the-chain': gatewayStampsTheChain,        // a tab's appended hop reaches no subscriber row and no co-member's guard (no Docker)
  'display-names-reach-subscribers': displayNamesReachSubscribers, // consent's nickname lands at a first accept and reaches a live subscriber at a later one (no Docker)
  // ── a Star converges on its Galaxy's CURRENT ontology, never on the asking tab's ──────────
  'star-serves-current-ontology': starServesCurrentOntology, // a stale tab cannot move a Star; a reverted ontology is served (Docker — two real Applies)
  'grant-reveals-denied': grantRevealsDenied, // a grant with no write reveals what a real member was denied (Docker — one real Apply)
  // ── a tab receives a call only from a sender its holder has passage into ───────────────────
  'client-sender-passage': clientSenderPassage, // a tab on a sibling Star is refused at the receiving Gateway by passage (no Docker)
  'gateway-one-binding': gatewayOneBinding, // /gateway/ refuses every binding but the client Gateway, before a Star exists (no Docker)
  'scope-teardown': scopeTeardown, // the facade's creates and deletes wipe Durable Objects server-side; records name the page (no Docker)
  'galaxy-cap': galaxyCap, // one owner cannot pass MAX_GALAXIES_PER_OWNER at create or acceptance; the root counts none (no Docker)
  'claim-lifecycle': claimLifecycle, // nothing enters a pending claim; a first acceptance wipes its scopes; every acceptance, claim and consume records (no Docker)
  'refresh-reads-the-host': refreshReadsTheHost, // which cookies the refresh reads, which membership it picks, and a dead cookie's expiry (no Docker)
  'links-sign-nobody-in': linksSignNobodyIn, // an image, a navigation or a rendered page signs nobody in; an invite pre-fills only for an accepted someone (no Docker)
  'links-sign-in-once': linksSignInOnce, // a link's button spends it, every replay finds it used, the cap refuses on the page (no Docker)
  'invites-land-on-their-host': invitesLandOnTheirHost, // a re-invite lands on its host; a 401 with a pending membership offers consent (no Docker)
  'logout-ends-every-host': logoutEndsEveryHost, // one logout ends every host, records each sub, and is bounded (no Docker)
  'hosts-and-frames': hostsAndFrames, // each host gets its own page, token and framing; no scope page reads Home's data (no Docker)
  'dev-tab-frame': devTabFrame, // Studio frames its dev tab; pushes, logout and a tokenless tab keep to their own sessions (Docker)
  'session-survives-token-lapse': sessionSurvivesTokenLapse, // a real 15-minute lapse, renewed through the platform host (no Docker, ~16 min)
  // ── every action lives on the page that owns it ─────────────────────────────────────────────
  'home-lists-every-profile': homeListsEveryProfile, // Home groups by Profile, marks what needs a fresh login, acts on nothing, steps aside for one app (no Docker)
  'logout-everywhere': logoutEverywhere, // the Profile page's link ends a session on a device this browser never saw, and records whose (no Docker)
  'studio-app-settings': studioAppSettings, // Studio lists its tenants and deletes one; a caller without dominion is refused by the facade (no Docker)
  // ── passage and dominion read the host's scope ──────────────────────────────────────────────
  'host-rule': hostRule, // a token acts from its host: dominion down, passage up, the facade refuses below the parent (no Docker)
  'persona-host': personaHost, // a persona's host mints the persona's token for a dev Star admin, and for nobody else (no Docker)
  'certificate-wake': certificateWake, // a create or acceptance wakes its galaxy's certificate order by name; nothing else does (no Docker)
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
 *
 * EVERY child's output is kept — one file per scenario under a per-sweep directory in the OS
 * temp dir, named beside each failure in the summary. Until 2026-09-06 a red's evidence died
 * with the process (only `HARNESS_DEBUG` printed it), which is how three `first-app-built`
 * 404s in one day went unattributed: the limb's own manifest line was printed and lost.
 *
 * A SOURCE EDIT DURING THE SWEEP IS DETECTED, not trusted to discipline: the files `wrangler
 * dev` watches are fingerprinted at boot and re-checked around every scenario. A save there
 * hot-reloads every later child's Worker, and a reload mid-request answers 503 — five phantom
 * reds in a row on 2026-09-05 (`live.md`). When it trips the sweep says so once, tags every
 * result from that scenario on as belonging to no tree, and exits non-zero.
 */
async function sweep(fast: boolean): Promise<void> {
  await sweepStalePacks();
  const { spawnSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync, readdirSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve, dirname } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const registered = Object.keys(SCENARIOS)
    .filter((n) => !fast || (SCENARIOS[n].needsContainer ?? true) === false);
  // PARKED scenarios are reported, never omitted — a limb held back by absence is a limb nobody
  // can see. They are listed before the run so the count at the top is the count that will print.
  const parked = registered.filter((n) => SCENARIOS[n].skip !== undefined);
  const names = registered.filter((n) => SCENARIOS[n].skip === undefined);
  const logDir = join(tmpdir(), 'lumenize-sweep', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(logDir, { recursive: true });
  console.error(`[harness] sweeping ${names.length} scenario(s)${fast ? ' (container-free only)' : ''} — each one's output kept under ${logDir}`);
  for (const n of parked) console.error(`⏭️  ${n.padEnd(26)} PARKED — ${SCENARIOS[n].skip}`);
  console.error('');

  // The watched tree: the Worker's own source, the packages it bundles, and the container
  // image's context. mtime + size per file, hashed; a scan of a few hundred stats is the cost.
  const repoRoot = resolve(dirname(process.argv[1]!), '..', '..', '..');
  const watched = ['apps/nebula/src', 'apps/nebula/container',
    ...readdirSync(join(repoRoot, 'packages')).map((p) => `packages/${p}/src`)];
  const fingerprint = (): string => {
    const h = createHash('sha1');
    const walk = (dir: string): void => {
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name === 'node_modules' || e.name === '.wrangler' || e.name === 'dist') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) { const st = statSync(full); h.update(`${full}:${st.mtimeMs}:${st.size}\n`); }
      }
    };
    for (const w of watched) walk(join(repoRoot, w));
    return h.digest('hex');
  };
  const booted = fingerprint();
  let taintedFrom: string | undefined;
  const checkTree = (name: string): void => {
    if (taintedFrom === undefined && fingerprint() !== booted) {
      taintedFrom = name;
      console.error(`\n⚠️  source under wrangler dev's watch changed since this sweep booted — every result from "${name}" on belongs to no tree (live.md: a sweep and a source save cannot overlap)\n`);
    }
  };

  const results: Array<{ name: string; ok: boolean; secs: string; detail: string; tainted: boolean }> = [];
  for (const name of names) {
    const t0 = Date.now();
    checkTree(name);
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
        // The parent swept stale packs once already, so each child skips it.
        env: { ...process.env, ...SCENARIOS[name].sweepEnv, HARNESS_PACKS_SWEPT: '1' },
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    writeFileSync(join(logDir, `${name}.log`), out);
    const ok = child.status === 0;
    const detail = ok ? '' : (/^(?:AssertionError|\w*Error):.*$/m.exec(out)?.[0] ?? '(see the kept output)').slice(0, 120);
    checkTree(name); // an edit DURING this scenario taints it too
    const tainted = taintedFrom !== undefined;
    results.push({ name, ok, secs: ((Date.now() - t0) / 1000).toFixed(1), detail, tainted });
    console.error(`${ok ? '✅' : '❌'} ${name.padEnd(26)} ${results.at(-1)!.secs}s ${detail}${tainted ? ' (source changed mid-sweep)' : ''}`);
    if (!ok && process.env.HARNESS_DEBUG) console.error(out);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[harness] ${results.length - failed.length}/${results.length} passed${parked.length > 0 ? `, ${parked.length} parked` : ''}`);
  for (const n of parked) console.log(`  ⏭️  ${n} — PARKED, not run: ${SCENARIOS[n].skip}`);
  for (const f of failed) console.log(`  ❌ ${f.name} — ${f.detail}\n     output: ${join(logDir, `${f.name}.log`)}`);
  if (failed.length > 0) console.log(`  (every scenario's full output is under ${logDir})`);
  if (taintedFrom !== undefined) {
    console.log(`\n⚠️  the source changed during the sweep — results from "${taintedFrom}" on belong to no tree; re-run the sweep`);
  }
  if (failed.length > 0 || taintedFrom !== undefined) process.exitCode = 1;
}

/**
 * On a deployed target, delete the test zone's certificate packs older than the sweep's window
 * (`lib/test-scopes.ts`), once per run. A local stack orders no packs, so it sweeps nothing. A run
 * without the test zone's token and id in `.dev.vars` still runs, and says the packs went unswept.
 */
async function sweepStalePacks(): Promise<void> {
  if (!process.env.HARNESS_TARGET_URL || process.env.HARNESS_PACKS_SWEPT) return;
  let token: string;
  let zoneId: string;
  try {
    token = readDevVar('TEST_CERTIFICATE_API_TOKEN');
    zoneId = readDevVar('TEST_CERTIFICATE_ZONE_ID');
  } catch {
    console.error('[harness] ⚠️  no TEST_CERTIFICATE_API_TOKEN / TEST_CERTIFICATE_ZONE_ID in .dev.vars — '
      + "stale test packs are not swept, and the test zone's pack count only grows");
    return;
  }
  const zoneHost = new URL(TEST_ORIGIN).hostname;
  try {
    const deleted = await sweepStaleTestPacks(cloudflareCertificateApi(zoneId, token), zoneHost, new Date(),
      (line) => console.error(`[harness] ${line}`));
    console.error(`[harness] swept ${deleted.length} stale test pack(s) on ${zoneHost}`);
  } catch (e) {
    // A failed listing leaves the packs for the next run; it is no reason to skip this one.
    console.error(`[harness] ⚠️  the stale-pack sweep failed: ${(e as Error).message}`);
  }
}

installLocalhostLookup();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv.find((a) => !a.startsWith('-')) ?? 'message-roundtrip';
  if (name === 'all') return sweep(argv.includes('--fast'));

  const scenario = SCENARIOS[name];
  if (!scenario) {
    const known = Object.entries(SCENARIOS)
      .map(([n, sc]) => (sc.skip === undefined ? n : `${n} (parked)`))
      .join(', ');
    console.error(`[harness] unknown scenario "${name}". Known: all, ${known}`);
    process.exitCode = 2;
    return;
  }
  const needsContainer = scenario.needsContainer ?? true;
  // A direct run of a PARKED scenario still runs it — that is what parking is for: the phase that
  // writes a red-first limb watches it fail here, and the phase that closes the hole watches it
  // pass, both before the flag comes off. The sweep is the venue that holds back.
  if (scenario.skip !== undefined) {
    console.error(`[harness] ⚠️  "${name}" is PARKED (the sweep does not run it) — ${scenario.skip}`);
    console.error('[harness] running it anyway, because you named it directly.');
  }

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
    await sweepStalePacks();
  } else {
    console.error(needsContainer
      ? '[harness] booting a fresh local wrangler dev (cold build-box image build can take a few minutes)…'
      : '[harness] booting a fresh local wrangler dev WITHOUT the build box (no Docker needed)…');
  }
  const stack: DevStack = target
    ? {
        // The target's platform host, wherever HARNESS_TARGET_URL points on it: every session route
        // answers there. The only deployed target is the test one, whose origin its config names.
        baseUrl: hostOrigin({ kind: 'platform' }, TEST_ORIGIN, target),
        origin: TEST_ORIGIN,
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
    // The Worker's own side of the story, kept with the red: the last of the dev stack's
    // stdio (its debug markers under the booted `DEBUG` namespaces). A red that only
    // quotes the scenario's assertion cannot be attributed — 2026-09-06's `build-box` 404
    // had four green build reports behind it and nothing said what the dist did.
    const stdio = stack.logs?.();
    if (stdio) {
      const lines = stdio.split('\n');
      console.error(`── dev stack stdio, last ${Math.min(lines.length, 400)} of ${lines.length} lines ──`);
      console.error(lines.slice(-400).join('\n'));
    }
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
