/**
 * Live self-verification harness — reusable core.
 *
 * The standalone driver behind `tasks/archive/claude-live-verification.md`: boot a fresh local
 * `wrangler dev`, mint a correct-shape Nebula admin token for a sandbox scope (NO email —
 * `createNebulaTestToken` with the `.dev.vars` signing key), connect a real-WS `NebulaClient`,
 * and drive/inspect arbitrary scenarios. Not a fixed vitest test — invoked from Bash via
 * `tsx` (`harness/drive.ts`), so I can verify a change against a *running* system before
 * reporting it done.
 *
 * Lifted from the ui-smoke lane (`test/ui-smoke/global-setup.ts`) + the bench harness
 * (`test/browser/multi-client.ts`), generalized off vitest. Runs in plain Node: imports only
 * the Node-safe subpaths (`@lumenize/nebula/client`, `@lumenize/nebula-auth/testing`,
 * `@lumenize/auth/client`, `@lumenize/testing`) — none pull `cloudflare:workers`.
 *
 * Local `wrangler dev` needs Docker Desktop (the DevContainer builds at boot) — the harness
 * probes it and fails loudly if absent. PROD driving is deliberately NOT here: prod tokens come
 * via audited login / stored-refresh, never this local mint (Phase 3 security boundary).
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnWranglerDev } from '@lumenize/testing/wrangler';
import { Browser } from '@lumenize/testing';
import { NebulaClient } from '@lumenize/nebula/client';
import { createNebulaTestToken } from '@lumenize/nebula-auth/testing';
import { signJwt, importPrivateKey, createJwtPayload } from '@lumenize/auth/client';

const HARNESS_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // apps/nebula/harness
const NEBULA_DIR = dirname(HARNESS_DIR); // apps/nebula
const STUDIO_UI_DIR = resolve(NEBULA_DIR, '../nebula-studio-ui');
/** apps/nebula config — the only one with DEV_STUDIO / DEV_CONTAINER / the AI binding. */
const WRANGLER_CONFIG = './wrangler.jsonc';

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
export async function bootDevStack(opts: { readyTimeoutMs?: number } = {}): Promise<DevStack> {
  if (!HAS_DOCKER) {
    throw new Error(
      'bootDevStack: Docker Desktop is not reachable (`docker info` failed). The apps/nebula ' +
        'DevContainer builds at `wrangler dev` boot, so Docker is required. Start Docker Desktop and retry.',
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
  const { baseUrl, cleanup } = await spawnWranglerDev({
    configPath: WRANGLER_CONFIG,
    cwd: NEBULA_DIR,
    // Cold DevContainer image build can be slow; give generous headroom.
    readyTimeoutMs: opts.readyTimeoutMs ?? 300_000,
    extraArgs: [
      ...(localMode ? ['--local'] : []),
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      ...(process.env.HARNESS_WORKER_DEBUG ? ['--var', `DEBUG:${process.env.HARNESS_WORKER_DEBUG}`] : []),
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
 * Mint a correct-shape admin token for `scope` (founder-equivalent — `access.admin` for its own
 * scope) and connect a real-WS `NebulaClient` bound to DEV_STUDIO (so chat `Session`/`Message`
 * Resources round-trip on the DevStudio DO). Resolves once connected.
 */
export async function connectDriver(
  stack: DevStack,
  opts: {
    scope: string;
    email?: string;
    isAdmin?: boolean;
    connectTimeoutMs?: number;
    /**
     * The token ISSUER's DO instance (drives the token's `authScopePattern`) — distinct from the
     * client's own gateway instanceName below. Default: `scope` (a founder of its own scope). Pass
     * `'nebula-platform'` to mint a `*` super-admin token whose `aud` is `scope` but whose reach is
     * global (`authScopePattern: '*'`, admin) — the cross-scope form.
     */
    issuerInstanceName?: string;
  },
): Promise<Driver> {
  const scope = opts.scope;
  // NebulaClient omits the base `refresh` fn (two-scope cookie model), so mint upfront and pass
  // `accessToken` + `instanceName` — the constructor then skips its own refresh (as
  // test/browser/multi-client.ts does). A longer TTL covers a slow scenario without a re-mint.
  const { access_token, sub } = await createNebulaTestToken({
    privateKey: stack.signingKey,
    activeKey: stack.activeKey,
    email: opts.email ?? 'claude@lumenize.io',
    activeScope: scope,
    instanceName: opts.issuerInstanceName ?? scope,
    isAdmin: opts.isAdmin ?? true,
    ttlSeconds: 3600,
  })();

  const browser = new Browser();
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
      emailVerified: true,
      adminApproved: true,
      isAdmin: true,
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
