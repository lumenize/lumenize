/**
 * DevContainer — the Studio dev-loop preview container (Nebula's `DEV_CONTAINER`
 * binding), addressed at the `{u}.{g}.dev` instance. A disposable Cloudflare
 * Container running real **vite** (HMR) that DevStudio pushes source to
 * (`applyChanges`) and serves the Preview app from. Holds NO durable truth — the
 * source-of-truth is DevStudio (shell `Workspace` + local git); on cold boot the
 * disk reverts to the baked image and DevStudio re-pushes the tree (Flow 1c).
 *
 * `extends NebulaContainer` (NOT bare LumenizeContainer): it inherits the
 * structural tenant-isolation `onBeforeCall` (the `{u}.{g}.dev` scope guard) on the
 * mesh path. Two ports:
 *  - **`:5173` vite** — public, ungated (the preview shell + HMR), reached via the
 *    DO `fetch()` proxy. `cf-container-target-port` is stripped by
 *    `LumenizeContainer.fetch()` so the public path can NEVER reach `:9000`.
 *  - **`:9000` command-server** — host-DO-only, reached exclusively by this DO's
 *    internal `containerFetch`. The command `@mesh` methods carry
 *    `@mesh(requireAdmin)` (NebulaContainer.onBeforeCall proves tenant *scope* but
 *    never `access.scopeAdmin`, and `<id>.*` widening admits descendant non-admins).
 *
 * DevStudio invokes the command methods via one-way `lmz.call()` continuations (the
 * continuation-only mesh model, ADR-003 — never raw Workers RPC, never an awaited
 * result). Ordering-critical sequences are collapsed into single atomic methods here
 * (`bootAndApply`/`warmAndAwaitReady`, ADR-006) so one fire-and-forget call preserves
 * the ordering container-side. vite fully owns SFC compile; the Star never compiles.
 * Deps are baked into the image → zero `npm install` on cold boot.
 *
 * ⚠️ `extends Container` does NOT construct under vitest-pool-workers
 * ([[container-no-construct-pool-workers]]); the composed seam is tested via
 * non-Container harnesses + the pure helpers below. The assembled-container e2e is an
 * `it.skip` run with `wrangler dev` + Docker Desktop (the Container runs locally there;
 * it just can't construct under pool-workers — testing.md § "What a skipped test needs").
 *
 * @see tasks/nebula-studio.md § DevContainer dev loop
 * @see tasks/nebula-dev-flows.md — Flow 1 / 1c + DevContainer internals
 */

import { mesh } from '@lumenize/mesh';
import { debug } from '@lumenize/debug';
import { NebulaContainer } from './nebula-container';
import { requireAdmin } from './nebula-do';

/** The command-server's port — distinct from vite's `defaultPort` (5173).
 *  Reachable ONLY via the DO's internal `containerFetch(req, CMD_PORT)`; the public
 *  `fetch()` proxy can never target it (the port header is stripped). */
const CMD_PORT = 9000;

/** KV key for the app-version the public `fetch()` injects into the shell. Pushed by
 *  DevStudio (`setAppVersion`) as the content hash of the ontology source. Persists in
 *  the DO across container cold-boots (only the container disk reverts, not the DO). */
const VERSION_KEY = 'devcontainer:appVersion';

/** KV key for the last `#forceReset()` abort timestamp (epoch ms). Read back on a
 *  reconstructed instance so the per-instance cooldown survives the abort it gates. */
const ABORT_TS_KEY = 'devcontainer:lastAbortMs';

/** Per-instance cooldown between forced `ctx.abort()` recoveries — an anti-thrash
 *  FREQUENCY bound (a reload loop / repeated probes), NOT a cross-tenant blast-radius
 *  bound (server-side stuck-corroboration is that; D6). Keyed per victim instance. */
const ABORT_COOLDOWN_MS = 30_000;

/** Bound on the recover-GET corroboration probe: a frozen-stuck container hangs the
 *  proxy, so an unbounded probe would wedge the recover invocation. A cold boot that
 *  outruns this reads as "Failed to start" (NOT stuck), so we never abort a
 *  legitimately-booting fresh container. */
const PROBE_TIMEOUT_MS = 5_000;

/** Bound on the best-effort `destroy()` inside `#forceReset()` so it can never block the
 *  load-bearing `ctx.abort()` (`destroy()` can hang on a frozen instance). */
const DESTROY_TIMEOUT_MS = 2_000;

/** One pushed source file. */
export interface SourceFile {
  path: string;
  content: string;
}

/**
 * Container-unavailability surfaced as a recognizable typed retryable error over
 * the mesh — NOT a 200 carrying a 503 body. The cold-start makes this concrete: the
 * first `containerFetch` races boot and returns a "Failed to…" text body (not JSON).
 * DevStudio detects via `err.name === 'ContainerUnavailableError'` + the `retryable`
 * flag and retries (mesh.md / Flow 1c boot-race).
 */
export class ContainerUnavailableError extends Error {
  status: number;
  /** The FULL container/proxy response body (untruncated). The stuck-flag predicate
   *  (`isStuckFlagError`) reads this, so the discriminating phrase (`Error proxying
   *  request to container:` — 36 chars) must never be clipped. The `message` truncates
   *  a copy for readability; this field keeps the whole body. */
  body: string;
  retryable = true;
  constructor(status: number, body = '') {
    super(
      `Container unavailable (HTTP ${status})${body ? `: ${body.slice(0, 200)}` : ''} — ` +
        `provisioning/cold-starting, evicted, or at capacity. Retry.`,
    );
    this.name = 'ContainerUnavailableError';
    this.status = status;
    this.body = body;
  }
}

/**
 * DO-side path-traversal guard (defense-in-depth — the command-server re-checks at
 * the write boundary, security.md "receiver re-validates"). Rejects any absolute
 * path or `..` segment BEFORE forwarding — nothing is written on reject. Pure +
 * synchronous so it's unit-testable without a live container. Throws on reject.
 */
export function assertSafeRelPath(path: string): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`Invalid source path: ${String(path)}`);
  }
  if (path.startsWith('/')) {
    throw new Error(`Absolute source path rejected: ${path}`);
  }
  if (path.split(/[/\\]/).includes('..')) {
    throw new Error(`'..' segment rejected in source path: ${path}`);
  }
}

/**
 * Inject the server-derived scope into the shell HTML as a `<meta>` tag (a
 * `<script>` would need a CSP nonce; a meta tag is strict-CSP-friendly). The
 * bootstrap reads it via `JSON.parse(meta[name=nebula-scope].content)`. Slugs are
 * `[a-z0-9-]` so the JSON has no single quotes to break the attribute. Pure so the
 * injection is unit-testable. The scope passed in is ALWAYS server-derived
 * (`this.lmz.instanceName`), never request-supplied — the wrong-Star footgun guard.
 */
export function injectScopeMeta(
  html: string,
  scope: { activeScope: string; authScope: string; appVersion: string },
): string {
  const meta = `<meta name="nebula-scope" content='${JSON.stringify(scope)}'>`;
  return html.includes('<head>') ? html.replace('<head>', `<head>\n    ${meta}`) : `${meta}\n${html}`;
}

/**
 * A non-OK proxy response that signals the container is cold/slept/provisioning — NOT a genuine app
 * error. When a container idle-sleeps, the `@cloudflare/containers` base proxy can hit a momentarily
 * stale `running` flag, skip its own auto-restart, and return a 5xx whose body carries one of these
 * runtime/base phrases (the monitor corrects the flag within ~a second, so a retry succeeds). 429/503
 * are always container-infra (capacity / no-instance — never an app's doing for a navigation); the
 * ambiguous 500/502 is matched by BODY signature so a genuine vite/app 500 is NOT masked.
 * Pure + synchronous so it's unit-testable without a live container.
 */
export function isContainerColdResponse(status: number, body: string): boolean {
  if (status === 429 || status === 503) return true; // rate-limited / no-instance — always container-infra, never an app's doing for a navigation
  if (status !== 500 && status !== 502) return false;
  return /not running|proxying request to container|Failed to start container|suddenly disconnected|provisioning/i.test(
    body,
  );
}

/**
 * The abort-worthy STUCK signature: a `500` whose body carries a base-proxy phrase that a
 * stale `this.container.running=true` flag produces — the container is "up" per CF but the
 * instance is dead/frozen and the base proxy won't restart past the flag. A GENUINE STRICT
 * SUBSET of {@link isContainerColdResponse}: every stuck response is also cold (so it serves
 * the waking page), but cold ⊋ stuck — `502`/`429`/`503`/provisioning and the crash-loop
 * `Failed to start container` are cold-but-NOT-stuck (never abort those — D3/M1/M3).
 *
 * `500`-only (M1): the base never emits `502` on the container path — a `502` is a CF edge
 * fault `ctx.abort()` can't fix (it stays cold→page, not stuck→abort). Excludes `Failed to
 * start container` (M3 — a genuine crash-on-boot / bad-image 500; aborting it loops
 * abort→recrash→abort) automatically, since that body carries none of the three proxy
 * phrases. The three phrases are the base-emitted proxy bodies: `container.js` L972
 * ("Container suddenly disconnected, try again") and L975 ("Error proxying request to
 * container: …", inside which the prod-observed "…not running…" rides).
 *
 * ⚠️ The verbatim prod stuck body was never captured (it self-heals off-prod — Phase 0), so
 * this is a conservative base-library-emitted superset, NOT a captured signature — narrow only
 * if a real stuck body is ever captured (tasks/nebula-container-wakeup-fix.md D3). Pure.
 */
export function isStuckFlagResponse(status: number, body: string): boolean {
  if (status !== 500) return false;
  return /not running|suddenly disconnected|proxying request to container/i.test(body);
}

/**
 * The command-path twin of {@link isStuckFlagResponse}: a `#cmdJson` failure carries the raw
 * `(status, body)` on {@link ContainerUnavailableError}, so the fetch path and the command
 * path (`ensureUp`) share ONE stuck signature. Defensive against a non-`ContainerUnavailableError`
 * throw (a plain Error lacks `status`/`body` → not stuck). Pure.
 */
export function isStuckFlagError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; body?: unknown };
  if (typeof e.status !== 'number' || typeof e.body !== 'string') return false;
  return isStuckFlagResponse(e.status, e.body);
}

/**
 * The per-instance abort cooldown decision (pure — the impure `Date.now()` and the durable
 * kv read/write live in `#forceReset`). Allows an abort iff none has happened yet, or the
 * window has fully elapsed since the last one. This is the ONLY bound on abort *frequency*,
 * and it must survive abort→reconstruct (the timestamp is durable), so its logic is
 * load-bearing (#4). Mirrors {@link nextRecoverAttempt}'s treatment of the reload counter.
 */
export function shouldAbortNow(lastAbortMs: number | undefined, nowMs: number, windowMs: number): boolean {
  if (lastAbortMs === undefined) return true;
  return nowMs - lastAbortMs >= windowMs;
}

/** True for a top-level preview navigation (vs a sub-asset request). Only the navigation gets the
 *  self-healing waking page; assets pass through and are re-fetched by the page's own reload. Pure. */
export function isDocumentRequest(request: Request): boolean {
  if (request.headers.get('sec-fetch-dest') === 'document') return true;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * True for the recover sentinel. Premise: the direct-serve route passes NO `prefix` and
 * `routeDORequest` forwards the FULL original URL (route-do-request.ts builds `new Request(request,
 * {headers})`), so `fetch()` sees `/dev-container/{u}.{g}.dev/_nebula/recover` — segments are NOT
 * stripped. Match the TRAILING sentinel; a legit asset that merely CONTAINS the substring
 * (`.../src/_nebula/recover.vue`) must NOT match (it ends in `.vue`, not the bare sentinel). Pure.
 */
export function isRecoverRequest(request: Request): boolean {
  return new URL(request.url).pathname.endsWith('/_nebula/recover');
}

/**
 * Cross-SITE CSRF guard for the recover GET (D6 layer 1): `/_nebula/recover` is a plain GET firing a
 * state-changing `ctx.abort()`, so a cross-site `<img src=…>` could otherwise trigger it. The
 * browser-set, unforgeable `Sec-Fetch-Site: same-origin` header rejects cross-site AND header-less
 * callers. ⚠️ Closes cross-*site* only — the server-side stuck-corroboration probe (NOT this header)
 * is the cross-*tenant* bound (D6 layer 2), since `Sec-Fetch-Site` is origin-scoped. Pure.
 */
export function isSameOriginRecover(request: Request): boolean {
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

/**
 * The same-origin recover sentinel URL for a preview request — the instance base
 * (`/{bindingSeg}/{instance}`) + `/_nebula/recover`, derived from the ROUTED request path.
 * Request-derived, NOT `this.lmz.instanceName` (unstamped on the fetch path, M5), so the page can
 * only ever recover the instance it was served for (the wrong-Star guard). Pure.
 */
export function previewRecoverUrl(request: Request): string {
  const segs = new URL(request.url).pathname.split('/'); // ['', '{bindingSeg}', '{instance}', ...]
  return `/${segs[1]}/${segs[2]}/_nebula/recover`;
}

/**
 * The public-preview serve decision, factored pure. `servePage` gates the friendly waking
 * interstitial — the existing `isDoc && !ok && isContainerColdResponse` gate, untouched.
 * `autoRecover` (meaningful only when `servePage`) arms the page's bounded self-heal and is true
 * ONLY for the abort-worthy stuck signature. A genuine app error (`servePage:false`) is passed
 * through untouched by the caller; a cold-but-not-stuck response serves the page with MANUAL reload
 * only (`autoRecover:false`, e.g. `502`/`503`/`429`/provisioning and the M3 crash-loop). Pure.
 */
export function decidePreviewResponse(
  status: number,
  body: string,
  isDoc: boolean,
): { servePage: boolean; autoRecover: boolean } {
  const ok = status >= 200 && status < 300;
  const servePage = isDoc && !ok && isContainerColdResponse(status, body);
  return { servePage, autoRecover: isStuckFlagResponse(status, body) };
}

/**
 * The bounded reload decision for the auto-recover page: reload iff fewer than 2 prior attempts (so
 * at most 2 auto-reloads, then the manual button is the final fallback). Pure AND embedded verbatim
 * into the page's inline JS (via `.toString()` in {@link wakingPreviewPage}) so the unit-tested
 * contract and the shipped browser logic cannot drift.
 */
export function nextRecoverAttempt(prevCount: number): { reload: boolean; nextCount: number } {
  return { reload: prevCount < 2, nextCount: prevCount + 1 };
}

/**
 * Friendly interstitial served when the container proxy fails (idle-slept / provisioning / a stuck
 * stale-`running` flag).
 *
 * `autoRecover` (true ONLY for the abort-worthy stuck signature — {@link isStuckFlagResponse}) drives
 * a BOUNDED self-heal: the page hits the `/_nebula/recover` sentinel (which server-side corroborates
 * the stuck state, then `ctx.abort()`s to force a clean reconstruct) and reloads once, at most twice
 * ({@link nextRecoverAttempt} via a `sessionStorage` counter), then falls back to the manual Reload
 * button. A cold-but-not-stuck response (`autoRecover:false`) shows the manual button only.
 *
 * ⚠️ This DELIBERATELY reverses the 2026-06-27 "no auto-reload" guard. That guard was correct when
 * recovery depended on idle-eviction (a reload storm renewed the activity timeout and BLOCKED the
 * evict that cleared the flag). Recovery is now abort-driven, so a BOUNDED reload no longer blocks the
 * clear — it drives it. The bound (≤2) + manual fallback keep it from becoming the old unbounded
 * hammer; there is deliberately NO unbounded `http-equiv=refresh`. Pure (no container round-trip).
 */
export function wakingPreviewPage(autoRecover = false, recoverUrl = ''): Response {
  // When autoRecover, embed nextRecoverAttempt VERBATIM (`.toString()`) so the shipped browser bound
  // can't drift from the unit-tested contract. This script runs ONLY in a real browser (ui-smoke /
  // prod) — never in the read-only unit tests — and the shipped/wrangler-dev build is un-instrumented,
  // so `.toString()` emits clean JS.
  const recoverScript = autoRecover
    ? `<script>(function(){` +
      `var nextRecoverAttempt=${nextRecoverAttempt.toString()};` +
      `var k='nebula-recover-attempts';` +
      `var d=nextRecoverAttempt(parseInt(sessionStorage.getItem(k)||'0',10)||0);` +
      `if(d.reload){sessionStorage.setItem(k,String(d.nextCount));` +
      `fetch(${JSON.stringify(recoverUrl)}).catch(function(){});` +
      `setTimeout(function(){location.reload();},1500);}` +
      `})();</script>`
    : '';
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Waking your preview…</title>` +
    `<style>body{font-family:system-ui,sans-serif;margin:0;height:100vh;display:grid;place-items:center;` +
    `background:#1d232a;color:#a6adbb}.box{text-align:center}.s{font-size:1.4rem;animation:p 1.5s ease-in-out infinite}` +
    `@keyframes p{50%{opacity:.4}}p{opacity:.6;font-size:.85rem}button{font:inherit;margin-top:1rem;padding:.5rem 1rem;` +
    `border-radius:.5rem;border:1px solid #3b4451;background:#2a323c;color:#a6adbb;cursor:pointer}</style></head>` +
    `<body><div class="box"><div class="s">⏳ Waking your preview…</div>` +
    `<p>It idle-slept to save resources. Give it a moment, then reload.</p>` +
    `<button onclick="location.reload()">Reload</button></div>${recoverScript}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export class DevContainer extends NebulaContainer {
  /** Public vite preview surface. The base `fetch()` pins the public proxy here and
   *  strips `cf-container-target-port`, so a browser can only reach vite. */
  override defaultPort = 5173;
  /** Warm-while-focused; idle sleep discards the disposable checkout (DevStudio is
   *  the durable source — re-pushed on next cold boot, Flow 1c). */
  override sleepAfter = '5m';

  /**
   * Inject the per-instance preview prefix as a container env var so vite serves under
   * the matching `base` (Decision 12 / Flow 1d): the preview is served at
   * `/dev-container/{instance}/`, so vite must emit prefixed asset URLs or they 404 at
   * the origin root. MUST be set before the container starts — `@cloudflare/containers`
   * reads `envVars` at start — so we set it from the routed instance name on every entry
   * path before the first `containerFetch`/proxy triggers start. Re-setting on a warm
   * container is a harmless no-op (only re-read on a (re)start).
   */
  #setPreviewBaseEnv(instance: string | undefined | null): void {
    if (!instance) return;
    this.envVars = { ...this.envVars, PREVIEW_BASE: `/dev-container/${instance}/` };
  }

  /** Reach the host-DO-only command-server (`:9000`), self-retrying the cold
   *  container (the first containerFetch races boot, Flow 1c). Non-2xx / non-JSON
   *  surfaces as a typed retryable `ContainerUnavailableError`. */
  async #cmdJson<T>(path: string, init?: RequestInit): Promise<T> {
    this.#setPreviewBaseEnv(this.lmz.instanceName); // before start: vite base (Flow 1d)
    const res = await this.containerFetch(new Request(`http://cmd.local${path}`, init), CMD_PORT);
    const text = await res.text();
    // Carry the FULL body (no 120-char clip) so `isStuckFlagError` can see the discriminating
    // proxy phrase — the command path shares the fetch path's ONE stuck signature.
    if (!res.ok) throw new ContainerUnavailableError(res.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ContainerUnavailableError(res.status, text);
    }
  }

  #postJson<T>(path: string, body?: unknown): Promise<T> {
    return this.#cmdJson<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  /**
   * Liveness probe + STUCK-container recovery. DevStudio fires this via one-way `lmz.call`
   * before pushing source (`chat` + the Studio's open/refresh), so the recovery rides those
   * existing paths. Mesh continuation-only shipped, so an abort here strands NO awaited caller:
   * the whole collapsed op (`bootAndApply`/`warmAndAwaitReady`) is dropped all-or-nothing and
   * the client re-pushes (`appVersion` kv survives; disk reverts + re-pushed, Flow 1c).
   *
   * A slept container can leave a **stale `this.container.running` flag** the base proxy can't
   * restart past (`start()`/`startAndWaitForPorts()` fast-path on the flag), so the probe gets
   * "not running" forever (the 2026-06-27 stuck state). On a **stuck-signature** failure we
   * `#forceReset()` (→ `ctx.abort()`): `destroy()`-only recovery is KNOWN-INSUFFICIENT for the
   * deploy-staled cloud flag (diagnosis Q2 — the same dead container id persisted across many
   * `destroy()` attempts; only idle-evict, or a forced abort = immediate idle-evict, clears it).
   * A NON-stuck failure — or a cooled-down `#forceReset()` no-op — falls back to the original
   * `destroy()` + ONE re-probe, which clears the milder cold-but-not-deploy-staled case.
   *
   * ⚠️ Verified live (`extends Container` can't construct under pool-workers) — see
   * [[feedback_test_container_changes_with_wrangler_dev]].
   */
  @mesh(requireAdmin)
  async ensureUp(): Promise<{ ok: boolean }> {
    try {
      return await this.#cmdJson('/healthz');
    } catch (err) {
      // Stuck stale-`running` flag → force DO reconstruction (destroy() can't clear the
      // deploy-staled flag). #forceReset() ends in ctx.abort() unless cooled down; if it
      // aborts, this invocation dies HERE and nothing below runs (the one-way caller strands
      // nothing). If cooled down (no abort), fall through to the destroy()+re-probe fallback.
      if (isStuckFlagError(err)) await this.#forceReset();
      this.#setPreviewBaseEnv(this.lmz.instanceName); // envVars are read at (re)start
      try {
        await this.destroy(); // SIGKILL → clears a NON-deploy-staled stale flag (stop() no-ops on it)
      } catch {
        /* already gone / destroy raced — the re-probe below still boots from a clean flag */
      }
      return await this.#cmdJson('/healthz'); // running=false now → containerFetch auto-starts clean
    }
  }

  /**
   * The shared post-authorization recovery primitive — BOTH the recover-GET (`#handleRecover`)
   * and the command path (`ensureUp`) call it. It does NO origin check and NO stuck-corroboration:
   * those are the CALLER's job (fetch() checks `Sec-Fetch-Site` + corroborates; ensureUp checks
   * `isStuckFlagError`), so it must NEVER be reached on a path that hasn't already gated (D5/D6).
   *
   * Cooldown (`shouldAbortNow`) → best-effort non-hanging `destroy()` → persist the abort timestamp
   * to `ctx.storage.kv` BEFORE `ctx.abort()` (so the cooldown survives the reconstruct the abort
   * triggers) → `ctx.abort()`. `ctx.abort()` is the load-bearing clear for the deploy-staled flag
   * (`destroy()` alone can't clear it — diagnosis Q2): it forces the DO to reconstruct and re-read
   * `this.container.running` from reality (the forced, immediate equivalent of the idle-eviction
   * that is otherwise the only cloud clear). Phase 0 CONFIRMED this mechanic on real CF.
   *
   * ⚠️ Do NOT cite `@cloudflare/containers` container.js L1416 as a persist-before-abort precedent —
   * there `ctx.abort()` comes FIRST and the following `setStopped()` is unreachable; the base shows
   * no such discipline. The persist-before-abort requirement stands on its own.
   */
  async #forceReset(): Promise<void> {
    const now = Date.now();
    const lastAbortMs = this.ctx.storage.kv.get<number>(ABORT_TS_KEY);
    if (!shouldAbortNow(lastAbortMs, now, ABORT_COOLDOWN_MS)) return; // cooled down → no-op
    // destroy() clears the cold-but-not-deploy-staled case; it must NEVER block the abort (it can
    // hang on a frozen instance), so cap it. Input-gate opening here is moot — we abort immediately.
    // `.catch` on destroy so a late rejection (after the timeout already won the race) can't surface
    // as an unhandled rejection.
    await Promise.race([
      this.destroy().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, DESTROY_TIMEOUT_MS)),
    ]);
    // Persist BEFORE abort so the cooldown survives the reconstruct (#4). The yield between the put
    // and the abort is LOAD-BEARING: a sync `kv.put` commits to durable storage only when the DO
    // yields for I/O, and `ctx.abort()` with NO yield after the put DISCARDS the uncommitted write.
    // VERIFIED on deployed CF (throwaway `lmz-abort-kv-test`, 2026-07-04): bare `kv.put; abort` AND
    // `await ctx.storage.put; abort` both LOST the value, and a bare microtask yield was NOT enough;
    // a single macrotask (`setTimeout`) yield let the output gate flush → the value survived. So yield
    // once here before aborting. Stays within the sync-storage rule (the async `put` isn't a fix
    // anyway). NOT locally testable — miniflare's local abort reconstructs with wiped storage
    // regardless ([[miniflare-local-abort-wipes-storage]]).
    this.ctx.storage.kv.put(ABORT_TS_KEY, now);
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // flush the write before abort
    this.ctx.abort('DevContainer stuck-flag recovery');
  }

  /**
   * Resolve when vite is actually serving the preview (`:5173`) — **event-driven, no
   * polling**: the command-server holds this request until vite's own stdout `ready`
   * event fires (or a safety timeout → `ready:false`). DevStudio's `warmPreview` awaits
   * this before signalling the client, so the auto-refresh lands on a serving preview,
   * not a mid-boot one. ⚠️ Verified live ([[feedback_test_container_changes_with_wrangler_dev]]).
   */
  @mesh(requireAdmin)
  async awaitPreviewReady(): Promise<{ ok: boolean; ready: boolean }> {
    return this.#cmdJson('/vite/ready');
  }

  /**
   * Write DevStudio's pushed source files into the working tree (the `applyChanges`
   * receiver — Flow 1 / 1c). Validates every path shape FIRST (defense-in-depth;
   * the command-server re-validates at the write boundary), then forwards the batch
   * so a single bad path writes nothing. vite picks up the writes → HMR.
   */
  @mesh(requireAdmin)
  async applyChanges(files: SourceFile[]): Promise<{ ok: boolean; written: number }> {
    for (const f of files) assertSafeRelPath(f.path);
    debug('nebula.DevContainer.applyChanges').debug('apply', {
      instanceName: this.lmz.instanceName,
      count: files.length,
    });
    return this.#postJson('/apply', { files });
  }

  /**
   * Boot the container (self-healing `ensureUp`) THEN push source — the DevStudio
   * `ensureUp`/`chat` flow collapsed into ONE atomic container method (ADR-006). Under
   * the continuation-only model DevStudio fires this as a single fire-and-forget mesh
   * `call()` (no awaited callRaw), and the boot-before-write ordering is enforced HERE by
   * sequential local `containerFetch` round-trips instead of across two racing hops.
   * ⚠️ Run with `wrangler dev` + Docker (can't construct under pool-workers).
   */
  @mesh(requireAdmin)
  async bootAndApply(files: SourceFile[]): Promise<{ ok: boolean; written: number }> {
    await this.ensureUp();
    return this.applyChanges(files);
  }

  /**
   * Boot + push source + await vite-ready — the DevStudio `warmPreview` flow collapsed
   * into ONE atomic container method (ADR-006). DevStudio fires this 4-arg and its handler
   * pushes readiness to the client; the boot→apply→ready ordering is enforced here by
   * sequential local `containerFetch` round-trips. Long-running is fine (early-ack, no
   * held Promise). ⚠️ Run with `wrangler dev` + Docker (can't construct under pool-workers).
   */
  @mesh(requireAdmin)
  async warmAndAwaitReady(files: SourceFile[]): Promise<{ ok: boolean; ready: boolean }> {
    await this.ensureUp();
    await this.applyChanges(files);
    return this.awaitPreviewReady();
  }

  /** Run a buffered command in the container (host-DO-only by construction — the
   *  public path can't reach `:9000`). Used for `vite build` at publish + tooling. */
  @mesh(requireAdmin)
  async exec(payload: { cmd: string; args?: string[]; shell?: boolean; cwd?: string }): Promise<{
    stdout: string;
    stderr: string;
    code: number;
    durationMs: number;
  }> {
    return this.#postJson('/exec', payload);
  }

  /** Start/stop/restart the dev server (used at publish + recovery). */
  @mesh(requireAdmin)
  async viteControl(action: 'restart' | 'stop' | 'start'): Promise<{ ok: boolean; action: string }> {
    return this.#postJson(`/vite/${action}`);
  }

  /** Read a file back from the working tree (test/inspection of a landed push). */
  @mesh(requireAdmin)
  async readFileInContainer(path: string): Promise<{ content: string }> {
    assertSafeRelPath(path);
    return this.#postJson('/read', { path });
  }

  /**
   * Set the app-version the public `fetch()` injects into the shell's `nebula-scope`
   * meta. DevStudio pushes it (the server-derived `hashBlob` of the ontology source)
   * whenever the version changes, so the preview's client sends the SAME version the
   * `.dev` Star installed — Handler-1 matches instead of `OntologyStaleError` on every
   * op (Decision 12 / Flow 1d). Stored in the DO's `kv` (the DO persists across
   * container cold-boots — only the disk reverts), never request-supplied. Sync
   * (a single `kv.put`, no container round-trip).
   */
  @mesh(requireAdmin)
  setAppVersion(version: string): void {
    this.ctx.storage.kv.put(VERSION_KEY, version);
  }

  /**
   * Handle the `/_nebula/recover` GET — the user-visible self-heal path. Order (D4/D6):
   *  1. `isSameOriginRecover` (403 otherwise) — closes cross-SITE CSRF-via-GET (D6 layer 1).
   *  2. server-side stuck **corroboration** (`#probeStuck`) — the recover-GET does NOT trust the
   *     client's `autoRecover` claim; it aborts ONLY a genuinely-stuck container. This is what
   *     closes the cross-TENANT healthy-abort vector (D6 layer 2): an untrusted neighbor can trigger
   *     an abort only against a container the abort *recovers* (net-positive, data-safe), never kick
   *     a healthy/provisioning/crash-looping neighbor.
   *  3. `#forceReset()` — the shared post-authorization primitive (cooldown + abort).
   * The abort ends this invocation, so the recover request is EXPECTED to error out; the client
   * `.catch()`es it. Uses request-derived routing only — `routeDORequest` already routed to THIS
   * DevContainer by URL, so the abort tears down only this instance (never `this.lmz.instanceName`,
   * unstamped on the fetch path, M5).
   */
  async #handleRecover(request: Request): Promise<Response> {
    if (!isSameOriginRecover(request)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!(await this.#probeStuck())) {
      // Corroboration denied — healthy / provisioning / crash-loop. Never abort a container that
      // isn't genuinely stuck (the D6 cross-tenant bound). Benign no-op.
      return new Response('not stuck', { status: 200, headers: { 'cache-control': 'no-store' } });
    }
    await this.#forceReset(); // ends in ctx.abort() unless cooled down — this invocation then dies
    // Reached only if cooled down (no abort this time). The page's bounded reload + manual button
    // are the fallback.
    return new Response('cooling down', { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  /**
   * Bounded fresh probe corroborating the stuck signature (D4). A frozen-stuck container
   * (`running=true`, port dead) hangs the proxy → the `AbortSignal.timeout` fires → the base
   * returns/throws the proxy-path signature (`isStuckFlagResponse` true) or the probe itself
   * rejects (treated as stuck). A healthy `200`, a `503`/`429`/provisioning, or a crash-loop
   * `Failed to start container` → NOT stuck (never abort those). The two hang variants produce
   * DIFFERENT base bodies — frozen skips the start block → the "proxying" phrase (stuck); a cold
   * boot enters it → "Failed to start" (not stuck) — so an in-flight legit boot is never aborted.
   */
  async #probeStuck(): Promise<boolean> {
    try {
      const probe = await this.containerFetch(
        new Request('http://cmd.local/healthz', { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        CMD_PORT,
      );
      const body = await probe.text().catch(() => '');
      return isStuckFlagResponse(probe.status, body);
    } catch {
      // The probe threw / aborted before producing a Response — a frozen-stuck container that hung
      // the proxy past the timeout. Treat as stuck.
      return true;
    }
  }

  /**
   * Public preview surface — a three-way branch (never blanket-buffer):
   *  - WS upgrade (vite HMR) → forward `super.fetch()` verbatim (ungated).
   *  - shell `index.html` → buffer + inject the SERVER-DERIVED scope, fresh Response.
   *  - other assets → stream `super.fetch()` unchanged.
   * `super.fetch()` = `LumenizeContainer.fetch()`: strips `cf-container-target-port`
   * (M1), stamps identity from the routed headers (B1), proxies vite. So
   * `activeScope` here is `this.lmz.instanceName` (server-derived from routing),
   * NEVER request-supplied — the wrong-Star footgun guard.
   */
  override async fetch(request: Request): Promise<Response> {
    // Recover sentinel FIRST — before #setPreviewBaseEnv and the WS branch (#9): on this path the
    // DO is about to be torn down (ctx.abort), so neither the envVars mutation nor WS handling is
    // wanted. Uses request-derived data only (this.lmz.instanceName isn't stamped until
    // super.fetch()); routeDORequest already routed to THIS DevContainer by URL.
    if (isRecoverRequest(request)) return this.#handleRecover(request);

    // Set the preview base BEFORE super.fetch() triggers the container start (envVars are
    // read at start). On a cold direct GET the instance isn't stamped yet, so read it from
    // the routing header; warm DOs have `this.lmz.instanceName` (Decision 12 / Flow 1d).
    this.#setPreviewBaseEnv(
      request.headers.get('x-lumenize-do-instance-name-or-id') ?? this.lmz.instanceName,
    );
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return super.fetch(request); // HMR WebSocket — forward verbatim, never buffer
    }
    const res = await super.fetch(request);

    // Cold-container recovery (idle-sleep → stale `running` flag → base proxy 5xx it can't restart
    // past; see isContainerColdResponse). On the top-level preview navigation, serve a friendly
    // waking page; the abort-worthy STUCK signature additionally arms the page's BOUNDED self-heal
    // (autoRecover → /_nebula/recover → corroborate → abort; ≤2 reloads, then a manual button). A
    // cold-but-not-stuck response serves the page with manual reload only. A genuine app error
    // (non-cold body) passes through untouched — never masked. (decidePreviewResponse factors the
    // decision; the recover URL is derived from the routed request path — the wrong-Star guard, M5.)
    if (isDocumentRequest(request) && !res.ok) {
      const body = await res.text();
      const { servePage, autoRecover } = decidePreviewResponse(res.status, body, true);
      if (servePage) return wakingPreviewPage(autoRecover, autoRecover ? previewRecoverUrl(request) : '');
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    if (!(res.headers.get('content-type') ?? '').includes('text/html')) {
      return res; // assets stream through unchanged
    }
    const activeScope = this.lmz.instanceName; // server-derived (B1-stamped), never the request
    if (!activeScope) {
      // No routed identity → can't derive scope. Fail loud rather than serve a shell
      // that would silently route the Preview app's data calls to the wrong Star.
      return new Response('Cannot serve preview: missing instance scope', { status: 500 });
    }
    const authScope = activeScope.split('.').slice(0, 2).join('.'); // {u}.{g} from {u}.{g}.dev
    // The version DevStudio installed on the `.dev` Star (server-derived hashBlob of
    // the ontology source), pushed here via setAppVersion. Empty until the first
    // ontology is applied — the preview can't do data ops before then anyway, and
    // injecting '' (not 'dev') keeps the contract honest (Decision 12 / Flow 1d).
    const appVersion = this.ctx.storage.kv.get<string>(VERSION_KEY) ?? '';
    const html = await res.text();
    const injected = injectScopeMeta(html, { activeScope, authScope, appVersion });
    const headers = new Headers(res.headers);
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.delete('content-length'); // body length changed
    return new Response(injected, { status: res.status, statusText: res.statusText, headers });
  }
}
