/**
 * Live self-verification harness — reusable core.
 *
 * The standalone driver behind `tasks/archive/claude-live-verification.md`: boot a fresh local
 * `wrangler dev`, obtain an identity for a sandbox scope via a REAL email login (rung 1, ADR-009 —
 * `connectDriver`; the synthetic mint is now an explicit, justified opt-in), connect a real-WS
 * `NebulaClient`, and drive/inspect arbitrary scenarios. Not a fixed vitest test — invoked from Bash via
 * `tsx` (`harness/drive.ts`), so I can verify a change against a *running* system before
 * reporting it done.
 *
 * Lifted from the ui-smoke lane (`test/ui-smoke/global-setup.ts`) + the bench harness
 * (`test/browser/multi-client.ts`), generalized off vitest. Runs in plain Node: imports only
 * the Node-safe entries (`@lumenize/nebula/client`, `@lumenize/nebula-auth/testing`,
 * `@lumenize/crypto`, `@lumenize/testing`) — none pull `cloudflare:workers`.
 *
 * Local `wrangler dev` needs Docker Desktop when the boot builds the container image — the
 * harness probes it and fails loudly if absent. PROD driving is deliberately NOT here: prod tokens come
 * via audited login / stored-refresh, never this local mint (Phase 3 security boundary).
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { Browser } from '@lumenize/testing';
import { NebulaClient, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula/client';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import type { InviteSummary, NebulaJwtPayload } from '@lumenize/nebula-auth/testing';
import { provisionAndLogin } from '../../test/lib/email-login';
import { signJwt, importPrivateKey, createJwtPayload, parseJwtUnsafe } from '@lumenize/crypto';
// @ts-expect-error — plain JS with JSDoc types (no build in dev, workflow.md); shared with `npm run dev`.
import { deriveLocalConfig } from '../../scripts/local-config.mjs';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
const NEBULA_DIR = dirname(HARNESS_DIR); // apps/nebula
const STUDIO_UI_DIR = resolve(NEBULA_DIR, '../nebula-studio-ui');
// The config a local boot uses is DERIVED from apps/nebula/wrangler.jsonc on every boot —
// `routes` always stripped (otherwise wrangler presents the production Host and every emailed
// magic link points at prod), `containers` stripped for scenarios that never touch
// `ctx.container` (the only Docker-needing piece). `scripts/local-config.mjs` carries the
// reasoning and is what `npm run dev` runs too, so the harness and a hand-driven stack boot the
// SAME shape. Only the image build is removed — the `GALAXY` binding and class stay.

/** A Docker daemon is reachable (`docker info` exits 0). Required for a with-container boot. */
export const HAS_DOCKER: boolean = (() => {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Read one variable's value from `apps/nebula/.dev.vars` (symlinked from the repo root).
 * Handles dotenv double-quoting + `\n` unescaping so a single-line quoted PEM
 * (`JWT_PRIVATE_KEY_BLUE="-----BEGIN...\n...\n-----END...\n"`) reconstructs to a real PEM.
 * NEVER log the return value for a key/secret name (security.md).
 */
export function readDevVar(name: string): string {
  const path = resolve(NEBULA_DIR, '.dev.vars');
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(new RegExp(`^${name}=(.*)$`, 'm'));
  if (!match) throw new Error(`readDevVar: ${name} not found in ${path}`);
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.replace(/\\n/g, '\n');
}

/** A booted local dev stack: the worker URL + the signing material + teardown. */
export interface DevStack {
  baseUrl: string;
  /** The Ed25519 private key PEM read from `.dev.vars` (never logged). */
  signingKey: string;
  /** The BLUE/GREEN selector this key belongs to (the JWT `kid`). */
  activeKey: 'BLUE' | 'GREEN';
  /** Kill `wrangler dev` + clean up. */
  cleanup: () => Promise<void>;
}

/**
 * Boot a fresh local `wrangler dev` on the apps/nebula config. Wipes `.wrangler/state` first so
 * every scope starts fresh (the ui-smoke "wipe, don't migrate" model — this IS the local wipe).
 * Uses `--local` when no `CLOUDFLARE_API_TOKEN` is present (drops the remote AI / send_email
 * bindings, which Phase-1 resource-plane driving doesn't need). Signs with BLUE by default;
 * pins `PRIMARY_JWT_KEY:BLUE` so the worker verifies BLUE-minted tokens.
 */
export async function bootDevStack(
  opts: {
    readyTimeoutMs?: number;
    /**
     * Whether this boot needs the build container image. Default `true` — the historical
     * behaviour, and correct for anything driving a build.
     *
     * Pass `false` for a scenario that never touches `ctx.container` (auth, impersonation, resources,
     * subscriptions): the image build is the ONLY thing in this stack that needs Docker, so skipping
     * it removes the Docker requirement entirely — and with it a per-operation approval prompt on a
     * machine where Docker is gated.
     */
    withContainer?: boolean;
    /**
     * Extra `--var NAME:VALUE` overrides for THIS boot only — never a `.dev.vars` mutation, so they
     * auto-revert per boot. For a scenario whose subject is server configuration the identity path
     * reads, e.g. `NEBULA_AUTH_BOOTSTRAP_EMAIL` (the superuser scenario points it at an address on
     * the test catch-all, so the bootstrap login can be a REAL email round trip rather than a mint).
     */
    vars?: Record<string, string>;
  } = {},
): Promise<DevStack> {
  const withContainer = opts.withContainer ?? true;
  if (withContainer && !HAS_DOCKER) {
    throw new Error(
      'bootDevStack: Docker Desktop is not reachable (`docker info` failed). The apps/nebula ' +
        'container image builds at `wrangler dev` boot, so Docker is required. Start Docker Desktop and retry, ' +
        'or pass `withContainer: false` if this scenario never touches `ctx.container`.',
    );
  }
  const signingKey = readDevVar('JWT_PRIVATE_KEY_BLUE');

  // Fresh DO store each run — `wrangler dev --local` persists `.wrangler/state`, and
  // `CREATE TABLE IF NOT EXISTS` does NOT migrate a stale schema (onStart #ensureRoot throws
  // SQLITE_MISMATCH). This wipe is the harness's local reset primitive.
  rmSync(resolve(NEBULA_DIR, '.wrangler/state'), { recursive: true, force: true });
  // wrangler HARD-ERRORS if the declared `assets.directory` (the Studio SPA dist) is absent;
  // an empty dir satisfies it with zero build (the harness drives the API, not the SPA).
  mkdirSync(resolve(STUDIO_UI_DIR, 'dist'), { recursive: true });

  // Boot exactly like `npm run dev` — NO `--local` by default. `npm run dev` reaches "Ready on"
  // using the wrangler OAuth session for the remote AI / `send_email remote:true` bindings; forcing
  // `--local` (an earlier auto-detect) made apps/nebula HANG after the container build (workerd up
  // but never ready). `--local` is opt-in for a no-OAuth environment (CI/hosted w/ a token) via
  // HARNESS_LOCAL=1. Keep boot args minimal (match the proven `npm run dev`); the only override is
  // PRIMARY_JWT_KEY:BLUE so the worker verifies with the same key the local mint signs with. Broad
  // `DEBUG` is opt-in (HARNESS_WORKER_DEBUG) — flooding every DO onStart slows startup.
  const localMode = process.env.HARNESS_LOCAL === '1';
  const configPath = deriveLocalConfig({ containers: withContainer });
  const { baseUrl, cleanup } = await spawnWranglerDev({
    configPath,
    cwd: NEBULA_DIR,
    // A cold container image build can be slow; give generous headroom.
    readyTimeoutMs: opts.readyTimeoutMs ?? 300_000,
    extraArgs: [
      ...(localMode ? ['--local'] : []),
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      ...(process.env.HARNESS_WORKER_DEBUG ? ['--var', `DEBUG:${process.env.HARNESS_WORKER_DEBUG}`] : []),
      // Turnstile is OFF in local dev by default (no secret → checkTurnstile skips). The
      // turnstile-canary scenario turns it ON for ONE boot by injecting a Turnstile *test* secret
      // (`1x0000…AA` = always-passes) via --var — no `.dev.vars` mutation, auto-reverts per boot.
      ...(process.env.HARNESS_TURNSTILE_SECRET
        ? ['--var', `TURNSTILE_SECRET_KEY:${process.env.HARNESS_TURNSTILE_SECRET}`]
        : []),
      ...Object.entries(opts.vars ?? {}).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
      '--log-level', 'info',
    ],
    onStdio: (chunk) => {
      if (process.env.HARNESS_DEBUG) process.stderr.write(chunk);
    },
  });

  return { baseUrl, signingKey, activeKey: 'BLUE', cleanup };
}

/** A connected driver: the real-WS client + its identity + lifecycle helpers.
 *
 *  There is deliberately NO `accessToken` field: production keeps the JWT inside the client
 *  (`client.scopes.*` / `client.invite` / `authedFetch`), so a scenario that hand-builds an
 *  `Authorization` header proves an endpoint works while skipping the code that reaches it in
 *  production — the exact divergence this tier exists to close. The last consumer (`/invite`,
 *  which had no client method) died when invites moved onto `NebulaClient.invite`. A scenario
 *  that genuinely needs a bearer holds the SESSION it logged in with (`EmailSession.accessToken`),
 *  which is a snapshot with the same staleness caveat. */
export interface Driver {
  client: NebulaClient;
  /** The subject UUID the mint assigned this identity. */
  sub: string;
  /** The active (== auth) scope this driver drives. */
  scope: string;
  /**
   * Fire the `.dev` sandbox wipe (`Star.resetDevData`, one-way — mirrors the Studio's Wipe
   * button). Best-effort; the deterministic local reset is {@link bootDevStack}'s fresh boot.
   */
  wipe: () => void;
  dispose: () => void;
}

/**
 * Post-collapse construction pairs for a driver at `scope`: resources live on the DO that OWNS
 * the scope (3 segments = a Star, 2 = a Galaxy), and chat always lives at the covering Galaxy
 * (`{u}.{g}`). A universe-tier driver gets no chat pair — the client's chat surface then throws
 * loudly rather than misrouting, by design. A scenario exercising a different plane overrides
 * per-driver: each driver sets the pair for the plane it exercises.
 */
function constructionPairs(scope: string): {
  resourceHostBinding: string;
  chatHostBinding?: string;
  chatScope?: string;
} {
  const parts = scope.split('.');
  const galaxy = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : undefined;
  return {
    resourceHostBinding: parts.length >= 3 ? 'STAR' : 'GALAXY',
    ...(galaxy ? { chatHostBinding: 'GALAXY', chatScope: galaxy } : {}),
  };
}

/** Poll until the client reaches `connected`, or throw on timeout. */
async function waitForConnected(client: NebulaClient, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (client.connectionState !== 'connected') {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `waitForConnected: not connected within ${timeoutMs}ms (state=${client.connectionState})`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Connect a real-WS `NebulaClient` for `scope`, with the post-collapse construction pairs derived
 * from the scope's tier (see {@link constructionPairs}). Resolves once connected.
 *
 * ⚠️ **Identity comes from a REAL email login by default** (rung 1, ADR-009). This harness is the
 * artifact the ADR names as *"the path design reasoning grounds on"*, so running it on a synthetic
 * identity was the exact mis-grounding the ADR was written about, sitting inside the ADR's own
 * instrument. Cost is not the obstacle: the loop is ~1.4 s and boot dwarfs it.
 *
 * Pass `session` when a scenario has ALREADY obtained a real server token by some other real path
 * — `provisionStarAdmin`, say, which is the only way to get a member whose `authScope` is a Star
 * rather than the universe above it. That is still rung 1: the claim is the server's either way,
 * and this only spares a second login for an identity that already exists.
 *
 * Pass `mint` for an identity the real path genuinely CANNOT produce — and say why in `reason`.
 */
export async function connectDriver(
  stack: DevStack,
  opts: {
    scope: string;
    /** Login identity. Defaults to a fresh `test-<uuid>@lumenize.io` (routed by the catch-all). */
    email?: string;
    /**
     * The INSTALLED ontology version this driver's resource ops ride (the host enforces it —
     * `OntologyStaleError` on a mismatch). Default: the platform chat version, right for the
     * galaxy chat plane; a Star-plane scenario that installs its own version passes it here.
     */
    ontologyVersion?: string;
    connectTimeoutMs?: number;
    /**
     * An access token this scenario already obtained from the SERVER by a real login. Still rung 1
     * — the claim was minted by the running system, not constructed here — and it exists because
     * the default path (`provisionAndLogin`) always climbs from the universe, so it cannot produce
     * a member whose own scope is a Star. Mutually exclusive with `mint`.
     */
    session?: { accessToken: string; sub: string };
    /**
     * Escape hatch to rung 3 (synthetic mint) — ONLY for identities real login can't create, e.g. a
     * NON-admin at a scope whose scope admin would be admin. `reason` is required and is not decorative:
     * ADR-009 says each surviving mint is justified per-site, so the justification lives at the call
     * site instead of in a reviewer's memory. If you're reaching for this to save time, don't — the
     * whole point of the measurement is that time isn't the trade-off.
     */
    mint?: {
      reason: string;
      scopeAdmin?: boolean;
      /**
       * The token ISSUER's DO instance — it BECOMES `access.authScope` verbatim, and is distinct
       * from the client's own gateway instanceName. Default `scope` (admin of its own scope);
       * `'nebula-platform'` mints a superuser whose `aud` is `scope` but whose dominion is global,
       * the platform scope being the ROOT of the scope tree.
       *
       * ⚠️ **Defaulting to `scope` means this mint path cannot produce a DENIAL by narrowing** —
       * narrow the scope and the claim narrows with it, in lockstep, so the caller always covers
       * its own `aud`. A scenario whose subject IS a refusal must set this explicitly, or better,
       * use the `provisionAndLogin` path below, where the server decides the claim.
       */
      issuerInstanceName?: string;
    };
  },
): Promise<Driver> {
  const scope = opts.scope;
  const browser = new Browser();

  // NebulaClient omits the base `refresh` fn (two-scope cookie model), so obtain the token upfront
  // and pass `accessToken` + `instanceName`; the constructor then skips its own refresh.
  let access_token: string;
  let sub: string;
  if (opts.session) {
    if (opts.mint) {
      throw new Error('connectDriver: pass `session` OR `mint`, never both — they are different rungs');
    }
    ({ accessToken: access_token, sub } = opts.session);
  } else if (opts.mint) {
    // `email` is not a JWT claim (tasks/nebula-auth-surrogate-sub.md) — identity is the surrogate
    // `sub`, so the mint takes no email.
    ({ access_token, sub } = await createNebulaTestToken({
      privateKey: stack.signingKey,
      activeKey: stack.activeKey,
      activeScope: scope,
      instanceName: opts.mint?.issuerInstanceName ?? scope,
      scopeAdmin: opts.mint?.scopeAdmin ?? true,
      ttlSeconds: 3600,
    })());
  } else {
    // provisionAndLogin, not a bare login: a fresh boot has no scopes at all, and login
    // never mints an identity. It claims the universe (the one open admin-minting entry),
    // logs in there for real, then creates the galaxy/star beneath with that admin's token.
    const result = await provisionAndLogin({
      baseUrl: stack.baseUrl,
      scope,
      email: opts.email,
      testToken: readDevVar('TEST_TOKEN'),
      fetchImpl: browser.fetch,
      // No bypassToken: Turnstile is OFF in local dev (no secret → checkTurnstile skips). The
      // turnstile-canary scenario, which turns it ON, drives the endpoint directly.
    });
    access_token = result.accessToken;
    sub = result.sub;
  }

  const ctx = browser.context(stack.baseUrl);
  const client = new NebulaClient({
    baseUrl: stack.baseUrl,
    authScope: scope,
    activeScope: scope,
    ontologyVersion: opts.ontologyVersion ?? CHAT_MESSAGE_ONTOLOGY_VERSION,
    ...constructionPairs(scope),
    accessToken: access_token,
    instanceName: `${sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });

  await waitForConnected(client, opts.connectTimeoutMs ?? 30_000);

  return {
    client,
    sub,
    scope,
    wipe: () => {
      // `resetDevData` lives on the `.dev` Star and throws off it, so only a star-tier driver
      // has a wipe target; elsewhere the deterministic reset is the fresh boot.
      if (scope.split('.').length < 3) return;
      try {
        // Fire-and-forget under the continuation-only model (mirrors nebula-studio-ui App.vue).
        client.lmz.call('STAR', scope, (client.ctn() as any).resetDevData());
      } catch {
        /* best-effort — the deterministic local reset is the fresh boot */
      }
    },
    dispose: () => {
      try {
        client[Symbol.dispose]();
      } catch {
        /* already disposed */
      }
      ctx.close();
    },
  };
}

/**
 * Invite through the ONE production surface — `NebulaClient.invite` → Gateway →
 * `NEBULA_AUTH_FACADE` — as a session that has already logged in by a real path. Constructs a
 * short-lived client from the session's token (a handed token on a client of the SAME identity —
 * the sanctioned shape; renewal never runs inside this one-call lifetime), invites, disposes.
 *
 * For a scenario that already holds a connected {@link Driver}, prefer `driver.client.invite(...)`
 * directly; this exists for the sites whose inviter is an `EmailSession` with no client.
 */
export async function inviteViaMesh(
  stack: DevStack,
  session: { accessToken: string; sub: string },
  targetScope: string,
  invitees: Array<{ email: string; scopeAdmin?: boolean }>,
  /** Sender-supplied display name — what the invitee's consent modal attributes to them. */
  inviterName?: string,
): Promise<InviteSummary> {
  const claims = parseJwtUnsafe(session.accessToken)!.payload as unknown as NebulaJwtPayload;
  const browser = new Browser();
  const ctx = browser.context(stack.baseUrl);
  const client = new NebulaClient({
    baseUrl: stack.baseUrl,
    authScope: claims.access.authScope,
    activeScope: claims.aud,
    // Inert here — this client lives for one `invite()` call and never touches resources.
    ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    accessToken: session.accessToken,
    instanceName: `${session.sub}.${crypto.randomUUID().slice(0, 8)}`,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
  });
  try {
    await waitForConnected(client, 30_000);
    return await client.invite(targetScope, invitees, inviterName);
  } finally {
    try { client[Symbol.dispose](); } catch { /* already disposed */ }
    ctx.close();
  }
}

/**
 * Mint a DELIBERATELY-DEGRADED token for the negative control.
 * - `'base'`  → the base mesh/auth shape (`createTestRefreshFunction`-equivalent): flat `scopeAdmin`,
 *   NO `access` claim, base issuer. This is the exact "wrong shape for Nebula" the task names.
 *   ⚠️ The `scopeAdmin`/`emailVerified`/`adminApproved` flags are passed as `customClaims` but land
 *   FLAT on the token — `createJwtPayload` spreads the bag — so this really is the flat base shape,
 *   not a nested one. That flatness is the point of the control; a nested bag would degrade the
 *   token for a second, uninteresting reason and stop isolating the missing `access` claim.
 * - `'no-access'` → nebula issuer + valid `aud`/`sub`/`email` but STILL no `access` claim. Isolates
 *   `access.authScope` (router.ts) as the *sole* discriminator — the strongest control.
 *
 * Both must be rejected at the gateway; if either connected, the positive result would prove
 * nothing about the `access` claim being load-bearing.
 */
export async function mintDegradedToken(
  stack: DevStack,
  opts: { scope: string; kind: 'base' | 'no-access'; email?: string },
): Promise<string> {
  const privateKey = await importPrivateKey(stack.signingKey);
  const email = opts.email ?? 'claude@lumenize.io';
  const sub = crypto.randomUUID();
  if (opts.kind === 'base') {
    const payload = createJwtPayload({
      issuer: 'https://lumenize.local',
      audience: opts.scope,
      subject: sub,
      expiresInSeconds: 900,
      customClaims: { emailVerified: true, adminApproved: true, scopeAdmin: true },
    });
    return signJwt(payload as any, privateKey, stack.activeKey);
  }
  // 'no-access': nebula-shaped EXCEPT the access claim is absent.
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://nebula.lumenize.com',
    aud: opts.scope,
    sub,
    exp: now + 900,
    iat: now,
    jti: crypto.randomUUID(),
    email,
    adminApproved: true,
    // no `access` — the discriminator under test
  };
  return signJwt(payload as any, privateKey, stack.activeKey);
}

/**
 * Assert a degraded token is REJECTED at the gateway: a client whose `refresh` returns it must
 * NOT reach `connected` within `windowMs`, and should surface a terminal auth failure
 * (`onLoginRequired`). Resolves on confirmed rejection; throws if it connects (control failed).
 */
export async function assertTokenRejected(
  stack: DevStack,
  opts: { scope: string; token: string; windowMs?: number },
): Promise<void> {
  const windowMs = opts.windowMs ?? 8000;
  const browser = new Browser();
  const ctx = browser.context(stack.baseUrl);
  let loginRequired = false;
  const client = new NebulaClient({
    baseUrl: stack.baseUrl,
    authScope: opts.scope,
    activeScope: opts.scope,
    // Inert here — the whole point is that this client never connects, let alone reads.
    ontologyVersion: CHAT_MESSAGE_ONTOLOGY_VERSION,
    accessToken: opts.token,
    instanceName: `neg-control.${crypto.randomUUID().slice(0, 8)}`,
    fetch: browser.fetch,
    sessionStorage: ctx.sessionStorage,
    BroadcastChannel: ctx.BroadcastChannel,
    onLoginRequired: () => {
      loginRequired = true;
    },
  });
  try {
    const start = Date.now();
    while (Date.now() - start < windowMs) {
      if (client.connectionState === 'connected') {
        throw new Error(
          'assertTokenRejected: a degraded token REACHED connected — the gateway accepted the ' +
            'wrong shape, so the positive round-trip proves nothing about the access claim.',
        );
      }
      if (loginRequired) return; // terminal auth failure observed — rejected as expected
      await new Promise((r) => setTimeout(r, 50));
    }
    // Never connected within the window and never terminal — still "not accepted", but assert
    // we didn't silently sit in a retry loop that a real token would have cleared.
    if (client.connectionState === 'connected') {
      throw new Error('assertTokenRejected: connected after the window elapsed');
    }
  } finally {
    try {
      client[Symbol.dispose]();
    } catch {
      /* ignore */
    }
    ctx.close();
  }
}
