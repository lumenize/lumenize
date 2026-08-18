# Does the Registry need an origin check of its own?

**Status:** Drafted 2026-08-17, **design intent only — no phases, and the answer may be "no".** Carved out of [nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) on 2026-08-17, where a `sameOriginGuard` had been specified as part of the route-table work; a Stage-1 panel found it was the one *new capability* in a file whose claim is that no route changes what it refuses, and that as specified it conflicted with a deployed control and broke the local dev loop. It was cut rather than fixed in place. Not built. Gated on nothing.

> ⚠️ **This file must reach a verdict before it grows phases.** Three separate findings below argue the guard earns less than it first appears, and one of them arrived *after* the original design was written. **Do not treat the guard as decided.** If the answer is "no origin check", that is a complete and successful outcome for this file — write the reasoning down, add whatever narrow thing survives, and archive it.

**Objective — decide whether Nebula's Registry needs an origin check beyond what CORS and `SameSite` already provide, and if so, on which routes and with what relationship to `LUMENIZE_APPROVED_ORIGINS`.**

## Context and current state

### There is already a configured origin control, and it is deployed

`routeNebulaAuthRequest` calls `applyCorsPolicy(request, options.cors ?? false)`, which **403s any non-OPTIONS request carrying a disallowed `Origin`**, fed by `LUMENIZE_APPROVED_ORIGINS` from `apps/nebula/src/entrypoint.ts`. 🚨 **A `sameOriginGuard` that reads no configuration silently overrides it**: an origin the operator deliberately approved passes `applyCorsPolicy` and is then refused by the guard, so the env var goes dead for `/auth` while staying live for `/gateway` and the DO routes.

Collateral if that ships unnoticed: it falsifies published `website/docs/nebula/auth-flows.md` § *Cross-origin browser deploys*, and two source comments are already wrong in the *other* direction — `apps/nebula/wrangler.jsonc` and `entrypoint.ts` both say "Empty / unset → same-origin only", when empty actually means **no server-side `Origin` check at all** (`test/ui-smoke/global-setup.ts` states it correctly). ⇒ **Whatever this file decides, those two comments need correcting in the same change.**

### `SameSite=Strict` already closes CSRF on the cookie routes

Found 2026-08-17 while working `logout`, and it **undercuts the most attractive placement for the guard**. The refresh cookie is `SameSite=Strict` at both sites that write it (mint and clear), so a cross-**site** page cannot make the browser send it and cannot force a logout or a refresh. The residual is same-*site* only — a subdomain of the registrable domain — and the deliberate `lumenize.dev` (untrusted data plane) / `nebula.lumenize.com` (trusted control plane) split puts hostile tenant content on a **different** registrable domain, which is cross-site and therefore already blocked.

⚠️ **This matters because the review that cut the guard also recommended moving it onto `refresh-token` and `logout`** — on the reasoning that an origin check earns its place where the credential is **ambient**. The reasoning is right; the conclusion needs re-deriving, because `SameSite=Strict` is what "ambient" was standing in for, and it is already doing the work. Re-derive before adopting that recommendation (`calibration.md` §4).

### The open routes are where a cross-origin page can actually reach a handler

`/invite` and `/mint-narrower-token` require an `Authorization` header, which is not CORS-safelisted, so a cross-origin `fetch` triggers a preflight that cannot succeed — the browser refuses before sending. The open routes need no header at all: the Turnstile token rides the JSON body, and neither `checkTurnstile` nor `readJsonBody` inspects `Content-Type` (both call `.json()`), so a `text/plain` POST is a **CORS simple request** that reaches the handler and does work.

⚠️ **But on those same routes, `turnstileGuard` is immediately behind and a cross-origin page cannot produce a token.** So the harm an origin check prevents there is **the `siteverify` round trip**, not unauthorized work — a cost argument, not a security one. **State the harm plainly or drop the guard**; do not reach for the same-site-subdomain residual without checking it against the domain split above.

### It would break the everyday local dev loop

`apps/nebula-studio-ui/vite.config.ts` proxies `/auth`, `/gateway` and `/dev-container` to the Worker with `changeOrigin: true` — Host only, **no `Origin` rewrite**. That is the shared standalone dev server (5174 → 8787) and it has **three** consumers: `npm run dev:studio`, the `ui-smoke` lane (whose setup loads that very config and whose header says it relies on there being no origin check), and the `/live` harness (`harness/lib/browser.ts` `bootStudioVite`; captured artifacts show `localhost:5174/auth/.../refresh-token`).

⇒ **A `sameOriginGuard` as originally specified refuses every `/auth` POST from the everyday local frontend loop.** That is a **dev-server change**, not a "test lane adaptation", and it needs a criterion that a proxied browser login still works under local `wrangler dev` + `vite`. ⚠️ **No lane may be adapted by widening the guard.** The other artifact (`apps/nebula/vitest.config.js`) already rewrites the header, and its comment says it does so to satisfy `LUMENIZE_APPROVED_ORIGINS` — which is the first finding again.

## Design intent, constraints, and future state

**If a guard survives this analysis, these hold:**

- **It compares the caller's `Origin` against `new URL(request.url).origin`** — the origin the caller addressed — and refuses a mismatch. ⚠️ **A request with NO `Origin` passes, deliberately:** forging an omission is free, so refusing those breaks every non-browser caller (curl, server-to-server, the `/live` harness) while stopping nobody. ⇒ It is a fence against browser-originated cross-origin traffic and **never an authorization control**; no criterion may describe it as one.
- ⚠️ **It must resolve its relationship to `LUMENIZE_APPROVED_ORIGINS` explicitly** — either it admits `url.origin` ∪ the allow-list (one parameter, and the approved-origin path stays testable), or this file states that the allow-list no longer governs `/auth`. A criterion must pin **which mechanism refused**, through the debug sink or the response body, never the bare 403 — the two are indistinguishable as statuses.
- ✅ **`url.origin` is already load-bearing on a higher-stakes path**, so the comparison rests on something real: `worker-token.ts` and `nebula-auth-registry.ts` build the **emailed magic-link URL** from it, so a forgeable value would already let Nebula be made to mail a login link at someone else's host. The invariant is that Cloudflare's routing resolved the hostname against this Worker's own bindings — not that today's hostname list is short — which is why it covers custom domains at no cost and needs no allowlist to maintain as tenants attach them.
- ⚠️ **A page cannot make `Origin` and `Host` agree.** Both are forbidden header names in the Fetch spec, so page JavaScript sets neither: a page on one origin fetching another sends its own `Origin` and the target's `Host`. Only a non-browser client can make them match deliberately — which is why this discriminates browser-originated cross-origin traffic and nothing else.
- ⚠️ **It emits no header and MUST NOT be named `corsGuard`.** CORS is a guard *plus* an outbound decorator; this is only the guard half, and a CORS name invites someone to add header-emission to a step, which a linear list cannot express. Response decoration stays outside the pipeline — [nebula-route-pipeline.md](archive/nebula-route-pipeline.md) § *Decisions* holds that boundary.
- **It is a `*Guard`** — returns a `Response` to refuse, never throws (`.claude/rules/coding-style.md` § *Guard naming*; the router's blanket catch turns a throw into a 500).

## Decisions

| Decision | Rejected alternative — why |
|---|---|
| **The guard is not decided; this file must reach a verdict first** | Carrying it in [nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) — it was the sole new capability in a no-verdict-change refactor, it silently overrode a deployed operator control, and it broke the everyday local dev loop. Cutting it made that file's central claim true. |
| **An origin check on the `/gateway/` WebSocket upgrade is DECLINED — assessed, not deferred** | Adding one — an origin check on an upgrade exists to stop cross-site WebSocket hijacking, and hijacking works only when the credential is **ambient**. The Gateway's is not: the token rides `Sec-WebSocket-Protocol` (`packages/mesh/src/gateway-messages.ts` `extractWebSocketToken`), set explicitly by the client, and same-origin policy already stops another origin reading one. A cross-site page can open the socket and has no token to present; `onBeforeConnect` refuses it in the Worker, before any DO. ⇒ **The rule that generalises: an origin check earns its place only where the credential is ambient.** Any guard this file adds covers HTTP only and MUST NOT be described as covering the WS surface. |
| **CORS response decoration stays untouched** | Folding it into a pipeline step — a linear step list cannot express an outbound decorator. |

## Non-goals

- **The route pipeline and its table** → ✅ [nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) (BUILT + archived 2026-08-18). This file adds at most one step to rows that file defined; read `packages/nebula-auth/src/router.ts` rather than the frozen file.
- **CORS itself** — the decoration `routeNebulaAuthRequest` applies around dispatch.

## Relationships

- **Depends on** ✅ [nebula-registry-route-guards.md](archive/nebula-registry-route-guards.md) — SATISFIED 2026-08-18: the table is in source.
- **Touches** `apps/nebula-studio-ui/vite.config.ts` (the shared dev server), the `ui-smoke` lane, and the `/live` harness — none of which are test-only surfaces.
