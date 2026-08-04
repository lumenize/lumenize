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
 * Local `wrangler dev` needs Docker Desktop (the DevContainer builds at boot) — the harness
 * probes it and fails loudly if absent. PROD driving is deliberately NOT here: prod tokens come
 * via audited login / stored-refresh, never this local mint (Phase 3 security boundary).
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/nebula/client';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { provisionAndLogin } from '../../test/lib/email-login';
import { signJwt, importPrivateKey, createJwtPayload } from '@lumenize/crypto';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
const NEBULA_DIR = dirname(HARNESS_DIR); // apps/nebula
const STUDIO_UI_DIR = resolve(NEBULA_DIR, '../nebula-studio-ui');
/** apps/nebula config — the only one with DEV_STUDIO / DEV_CONTAINER / the AI binding. */
const WRANGLER_CONFIG = './wrangler.jsonc';
/**
 * A derived, container-free copy of the config, for scenarios that never touch the DevContainer.
 *
 * ⚠️ **Must live beside the original**: wrangler resolves `main`, `assets.directory` and every other
 * relative path against the CONFIG FILE's directory, so putting this under `.wrangler/` would break
 * all of them. Generated per boot and gitignored — never edit it, and never commit it.
 */
const WRANGLER_CONFIG_NO_CONTAINER = './wrangler.harness-no-container.jsonc';

/**
 * Comment out the `containers` block so `wrangler dev` does not build the image — the ONLY thing in
 * this stack that needs Docker.
 *
 * ⚠️ **Derived from the real config on every boot, never a second committed file.** A parallel config
 * would drift silently the first time someone edits bindings in one and not the other; deriving keeps
 * a single source of truth. It is a line-level comment-out rather than a JSONC re-serialisation
 * because no JSONC parser is available here and a regex comment-strip would corrupt any `//` inside a
 * string (an https URL, say).
 *
 * ⚠️ The `DEV_CONTAINER` binding and the `DevContainer` DO export are LEFT IN PLACE — only the image
 * build is removed. So the class still registers and `env.DEV_CONTAINER` still resolves; what a
 * scenario loses is `ctx.container`, which is exactly the capability it declared it does not need.
 *
 * Throws loudly if the config's shape has changed, rather than silently emitting a config that
 * differs from the original in ways nobody asked for.
 */
function deriveContainerFreeConfig(): string {
  const src = readFileSync(resolve(NEBULA_DIR, 'wrangler.jsonc'), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^\s*"containers"\s*:\s*\[\s*$/.test(l));
  if (start === -1) {
    throw new Error(
      'deriveContainerFreeConfig: no `"containers": [` line in apps/nebula/wrangler.jsonc. The config '
      + 'shape changed — update this derivation instead of letting it emit a config nobody reviewed.',
    );
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\],?\s*$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) {
    throw new Error('deriveContainerFreeConfig: unterminated `containers` array in apps/nebula/wrangler.jsonc.');
  }
  for (let i = start; i <= end; i++) lines[i] = `// [harness: container build disabled] ${lines[i]}`;
  const out = resolve(NEBULA_DIR, WRANGLER_CONFIG_NO_CONTAINER);
  writeFileSync(out, lines.join('\n'));
  return WRANGLER_CONFIG_NO_CONTAINER;
}

/** A Docker daemon is reachable (`docker info` exits 0). Required to boot the DevContainer. */
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
     * Whether this boot needs the DevContainer. Default `true` — the historical behaviour, and
     * correct for anything driving Studio codegen or a build.
     *
     * Pass `false` for a scenario that never touches `ctx.container` (auth, impersonation, resources,
     * subscriptions): the image build is the ONLY thing in this stack that needs Docker, so skipping
     * it removes the Docker requirement entirely — and with it a per-operation approval prompt on a
     * machine where Docker is gated.
     */
    withContainer?: boolean;
  } = {},
): Promise<DevStack> {
  const withContainer = opts.withContainer ?? true;
  if (withContainer && !HAS_DOCKER) {
    throw new Error(
      'bootDevStack: Docker Desktop is not reachable (`docker info` failed). The apps/nebula ' +
        'DevContainer builds at `wrangler dev` boot, so Docker is required. Start Docker Desktop and retry, ' +
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
  const configPath = withContainer ? WRANGLER_CONFIG : deriveContainerFreeConfig();
  const { baseUrl, cleanup } = await spawnWranglerDev({
    configPath,
    cwd: NEBULA_DIR,
    // Cold DevContainer image build can be slow; give generous headroom.
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
      '--log-level', 'info',
    ],
    onStdio: (chunk) => {
      if (process.env.HARNESS_DEBUG) process.stderr.write(chunk);
    },
  });

  return { baseUrl, signingKey, activeKey: 'BLUE', cleanup };
}

/** A connected driver: the real-WS client + its identity + lifecycle helpers. */
export interface Driver {
  client: NebulaClient;
  /** The subject UUID the mint assigned this identity. */
  sub: string;
  /** This identity's access token — needed ONLY where no client API reaches the endpoint yet.
   *
   *  ⚠️ **Prefer `client.scopes.*`.** Production keeps the JWT inside the client and issues authed
   *  HTTP itself (`authedFetch`), so app code never handles a bearer; a scenario that hand-builds an
   *  `Authorization` header proves the endpoint works while skipping the code that reaches it in
   *  production — the exact divergence this tier exists to close.
   *
   *  ⚠️ The one live gap is **`/invite`, which has no `client.scopes` method**, so an invite scenario
   *  must still call it directly. When that method lands, the remaining uses of this field go with it.
   *  It is a SNAPSHOT, so it also silently goes stale across a refresh — fine for a seconds-long
   *  scenario, wrong for anything that outlives one token. NEVER log this value. */
  accessToken: string;
  /** The active (== auth) scope this driver drives. */
  scope: string;
  /**
   * Fire the `.dev` sandbox wipe (`Star.resetDevData`, one-way — mirrors the Studio's Wipe
   * button). Best-effort; the deterministic local reset is {@link bootDevStack}'s fresh boot.
   */
  wipe: () => void;
  dispose: () => void;
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
 * Connect a real-WS `NebulaClient` for `scope`, bound to DEV_STUDIO (so chat `Session`/`Message`
 * Resources round-trip on the DevStudio DO). Resolves once connected.
 *
 * ⚠️ **Identity comes from a REAL email login by default** (rung 1, ADR-009). This harness is the
 * artifact the ADR names as *"the path design reasoning grounds on"*, so running it on a synthetic
 * identity was the exact mis-grounding the ADR was written about, sitting inside the ADR's own
 * instrument. Cost is not the obstacle: the loop is ~1.4 s and boot dwarfs it.
 *
 * Pass `mint` for an identity the real path genuinely CANNOT produce — and say why in `reason`.
 */
export async function connectDriver(
  stack: DevStack,
  opts: {
    scope: string;
    /** Login identity. Defaults to a fresh `test-<uuid>@lumenize.io` (routed by the catch-all). */
    email?: string;
    connectTimeoutMs?: number;
    /**
     * Escape hatch to rung 3 (synthetic mint) — ONLY for identities real login can't create, e.g. a
     * NON-admin at a scope whose scope admin would be admin. `reason` is required and is not decorative:
     * ADR-009 says each surviving mint is justified per-site, so the justification lives at the call
     * site instead of in a reviewer's memory. If you're reaching for this to save time, don't — the
     * whole point of the measurement is that time isn't the trade-off.
     */
    mint?: {
      reason: string;
      isAdmin?: boolean;
      /**
       * The token ISSUER's DO instance (drives `authScopePattern`) — distinct from the client's own
       * gateway instanceName. Default `scope` (admin of its own scope); `'nebula-platform'` mints
       * a `*` super-admin whose `aud` is `scope` but whose reach is global.
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
  if (opts.mint) {
    // `email` is not a JWT claim (tasks/nebula-auth-surrogate-sub.md) — identity is the surrogate
    // `sub`, so the mint takes no email.
    ({ access_token, sub } = await createNebulaTestToken({
      privateKey: stack.signingKey,
      activeKey: stack.activeKey,
      activeScope: scope,
      instanceName: opts.mint?.issuerInstanceName ?? scope,
      isAdmin: opts.mint?.isAdmin ?? true,
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
    appVersion: 'harness-v0',
    resourceHostBinding: 'DEV_STUDIO',
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
    accessToken: access_token,
    wipe: () => {
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
 * Mint a DELIBERATELY-DEGRADED token for the negative control.
 * - `'base'`  → the base mesh/auth shape (`createTestRefreshFunction`-equivalent): flat `isAdmin`,
 *   NO `access` claim, base issuer. This is the exact "wrong shape for Nebula" the task names.
 *   ⚠️ The `isAdmin`/`emailVerified`/`adminApproved` flags are passed as `customClaims` but land
 *   FLAT on the token — `createJwtPayload` spreads the bag — so this really is the flat base shape,
 *   not a nested one. That flatness is the point of the control; a nested bag would degrade the
 *   token for a second, uninteresting reason and stop isolating the missing `access` claim.
 * - `'no-access'` → nebula issuer + valid `aud`/`sub`/`email` but STILL no `access` claim. Isolates
 *   `access.authScopePattern` (router.ts) as the *sole* discriminator — the strongest control.
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
      customClaims: { emailVerified: true, adminApproved: true, isAdmin: true },
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
    appVersion: 'harness-v0',
    resourceHostBinding: 'DEV_STUDIO',
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
