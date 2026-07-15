# Mesh client peer-to-peer guard: check the immediate CALLER, not the ORIGIN

**Status**: **NEW (2026-07-14)** — a focused `@lumenize/mesh` framework fix, surfaced during the profile-store build (Larry's call). Reviewed via `/review-task` (Stage 1 + Stage 2) then **BUILT + verified via `/build-task` 2026-07-15** — all phases conform (verifier fan-out clean, 0 blockers/majors), all 3 mutation-checks RUN + observed to flip; **UNCOMMITTED**, ready for final human review. Small **core** fix (~4 lines in `@lumenize/mesh`), but its success criteria sweep `@lumenize/mesh` (src + JSDoc + new tests) + `apps/nebula` (remove overrides) + website docs, and it changes the **default security posture of the MIT foundation** — so it earns a review pass + a semver flag.

## The bug
`LumenizeClient.onBeforeCall()` ([lumenize-client.ts:710](packages/mesh/src/lumenize-client.ts)) is the client's default incoming-call guard. It means to block **peer-to-peer** calls (one client invoking another client's `@mesh` method), but it checks the **origin** of the chain:

```ts
onBeforeCall(): void {
  const origin = this.#currentCallContext?.callChain[0];          // ← the ORIGIN
  if (origin?.type === 'LumenizeClient') {
    if (origin.instanceName === this.#instanceName) return;       // allow self-originated
    throw new Error('Peer-to-peer client calls are disabled by default. Override onBeforeCall() to allow them.');
  }
}
```

The **DO-mediated fanout** every reactive app relies on (client A mutates → a DO fans out → client B receives `handleResourceUpdate`) has `callChain[0]` = the **writer client A** — a *different* client — so the guard **false-positive-rejects it**. That forces **every** real client to override `onBeforeCall` to permissive (`NebulaClient` does, [nebula-client.ts:1495](apps/nebula/src/nebula-client.ts)), and a subclass that *forgets* the override **silently drops all fanout updates** — a footgun that cost real debugging time in the profile-store build (the "Peer-to-peer client calls are disabled by default" error was masked and took Gateway+fanout instrumentation to trace).

**The guard is checking the wrong node.** The *actual* peer-to-peer risk — A **directly** calling B — is distinguishable by the **immediate caller**, not the origin.

## The mechanism (fanout-push leg empirically confirmed 2026-07-14 via `onBeforeCall` instrumentation; the RESULT-leg behavior is read from the client code)
Instrumented `onBeforeCall` on a real cross-scope fanout push (profile-store headline test). The chain the receiving client sees:

```
callChain = [ LumenizeClient(origin = the writer client), LumenizeDO(the PROFILE DO) ]
            └ callChain[0] = origin client          └ callChain.at(-1) = the DO (the immediate caller)
```

- **DO-mediated fanout** → `callChain.at(-1).type === 'LumenizeDO'` (the DO appends itself as the caller; the Gateway is not a mesh participant, so it isn't in the chain). Also covers `svc.broadcast`'s tier path (caller = a `LumenizeWorker`) and multi-hop direct-delivery (caller = the final DO).
- **Direct client→client** (A calls the Gateway targeting B, no DO) → `callChain = [A]`, so `callChain.at(-1)` = **A, a `LumenizeClient`**.
- **Self fire-back** (a client's own `callAsync`/4-arg result) → arrives on the **RESULT leg** (`#handleCallResponse`), which never invokes `onBeforeCall` — so the guard doesn't run on it *at all*, regardless of caller. The guard runs **only** on the unsolicited **incoming-call** leg (`#handleIncomingCall`, [lumenize-client.ts:1283](packages/mesh/src/lumenize-client.ts)). The self path the guard *does* see is a self-originated multi-hop direct-delivery incoming call (origin = self client, caller = a DO/Worker) → accepted.

So the immediate caller cleanly separates the legitimate case (DO/Worker) from the risk (client).

## The fix
In `LumenizeClient.onBeforeCall`, target the **immediate caller** instead of the origin, keeping the self-instance allowance:

```ts
onBeforeCall(): void {
  const caller = this.#currentCallContext?.callChain.at(-1);      // the IMMEDIATE caller, not the origin
  if (caller?.type === 'LumenizeClient' && caller.instanceName !== this.#instanceName) {
    throw new Error('Direct client-to-client calls are disabled by default. Override onBeforeCall() to allow them.');
  }
}
```

Net effect: **DO/Worker-mediated fanout is accepted by default** (no override needed anywhere) while a **direct client→client** call is still blocked by default — secure-by-default for the *actual* risk, footgun gone.

## Rejected alternatives (analysis already done — don't re-litigate)
- **Remove the guard entirely (permissive default).** Legitimate and "enough rope," but the base `LumenizeClientGateway.onBeforeCallToClient` is a **no-op default**, so a base consumer overriding neither would have *fully open* client↔client `@mesh` calls. The caller-based fix keeps the base mesh secure-by-default without the footgun, and fixes a latent bug rather than deleting a feature. (If a future decision says direct client→client isn't worth a framework default at all, removal is the fallback.)
- **`newChain: true` on the fanout call.** It *would* dodge the client guard (origin becomes the DO), but it also nulls `originAuth` ([lumenize-client.ts buildClientOutgoingContext](packages/mesh/src/lumenize-client.ts) → `originAuth: undefined`), which **breaks the Gateway's aud check** — the boundary the Star fanout depends on (`broadcast.ts` deliberately does NOT `newChain` so pushes inherit the mutator's aud). Not a fix; it trades a client-guard override for a broken Gateway boundary.

## Blast radius
- `@lumenize/mesh` (MIT foundation) — affects **all** consumers' default client security posture. **Semver-worthy** — flag the next release (CLAUDE.md favors breaking changes over debt; this is a behavior change to a documented default).
- After the fix, the permissive `onBeforeCall` overrides in **`NebulaClient`** and in **test probes** become unnecessary — see the sub-decision below.
- ADR-007 context: `onBeforeCall` is part of the shared narrow comms + guards core; this refines its default, not the mechanism.

## Success criteria (capable-of-failing)
- [x] **The default accepts DO-mediated fanout with NO override — proven in `@lumenize/mesh`'s own package.** A plain `LumenizeClient` (default `onBeforeCall`) receives a push fanned out by a mesh test DO that **preserves the writer-client origin** (the fanout does NOT `newChain`, so the receiver sees `callChain = [writerClient, DO]`, `callChain.at(-1)` = the DO). Mutation-check (**run it, observe the flip** — don't just assert in prose): revert the guard to `callChain[0]` and this reds (origin = the writer client, a `LumenizeClient`). ⚠️ The existing `for-docs/calls` DO fanout uses `{ newChain: true }` ([document-do.ts:290](packages/mesh/test/for-docs/calls/document-do.ts)) → `callChain[0]` = the DO, so it can't serve this mutation-check; build a no-`newChain` fanout fixture.
- [x] **The default still blocks a DIRECT client→client call — isolated from any Gateway fence.** Home this in `packages/mesh` on the **base `LumenizeClientGateway`** (its `onBeforeCallToClient` is a genuine no-op, [lumenize-client-gateway.ts:201-208](packages/mesh/src/lumenize-client-gateway.ts)), so the *client guard* is the sole rejecter. Client A calls client B's `@mesh` method directly (via the Gateway, no DO in the chain), with **A and B on distinct `instanceName`s** — else the guard's own `caller.instanceName !== this.#instanceName` self-allowance treats it as self and admits it. B (default guard) does NOT receive it. Capable-of-failing (**run+observe**): remove the guard entirely and B receives it. ⚠️ Do **NOT** anchor this to the Nebula profile-store harness: `NebulaClientGateway`'s same-`aud` fence rejects a cross-`aud` A→B *at the Gateway*, before B's `onBeforeCall` ever runs, so the test would green with **or** without the guard (a false pass on the exact posture this task exists to prove — and its distinct-scope fixtures make A/B cross-`aud` by construction).
- [x] **No regression on the accept side — caller = DO *and* caller = Worker.** The guard must accept an unsolicited push whose immediate caller is a `LumenizeWorker` (the `svc.broadcast` tier path — see The mechanism), not only a DO: exercise a caller=`LumenizeWorker` push against the *default* guard — it discriminates a DO-only-allow mistake (a `caller.type !== 'LumenizeDO'` bug reds it, where a caller=DO test would not). ⚠️ The self `callAsync`-*result* case is **NOT** guard coverage — the RESULT leg never invokes `onBeforeCall` (see The mechanism), so it passes under every implementation.
- [x] **`NebulaClient`'s permissive override is REMOVED** ([nebula-client.ts:1495](apps/nebula/src/nebula-client.ts)) — it inherits the corrected default (which now blocks direct client→client, a tightening), and its ~17-line justifying JSDoc ([nebula-client.ts:1481-1494](apps/nebula/src/nebula-client.ts), which describes the *old* `callChain[0]` default) goes with it. Removal is **safe and is the point**: `NebulaClientGateway.onBeforeCallToClient` ([nebula-client-gateway.ts:14](apps/nebula/src/nebula-client-gateway.ts)) is the real same-`aud` fence, and no Nebula flow does direct client→client (the only client-push pattern is DO-mediated fanout, which the new default accepts) — so removal is also the real-world proof the default now suffices in the dogfood consumer. All mesh + nebula client suites stay green. (If a *future* flow genuinely needs direct client→client, surface it then as a discovered blocker — do not pre-bless a kept override here.)
- [x] **Test-probe overrides removed** — the profile-store `SubscriberProbe`'s `override onBeforeCall(): void {}` ([profile-subscribe.test.ts](apps/nebula/test/test-apps/baseline/profile-subscribe.test.ts)) and any other test-only permissive override are deleted; those suites still pass (proving the default now allows fanout end-to-end, incl. the `NebulaClientTest` real-client update path).
- [x] **Guard-test inventory reconciled** — the new tests above are the primary capable-of-failing coverage of the *changed* behavior; reconcile them with what already exists:
  - **DELETE** the vacuous placeholder `describe('Default onBeforeCall')` at [lumenize-client.test.ts:659-681](packages/mesh/test/lumenize-client.test.ts) — it asserts nothing (no `expect()`, a legacy `origin:` field, never invokes the guard, self-documents "can't test this because #currentCallContext is private"). Don't "update" it into another renamed false-green.
  - Run `grep -rn 'Peer-to-peer\|onBeforeCall' packages/mesh/test apps/nebula/test` and edit **only** tests asserting the *client* peer-default. The DO-side `packages/mesh/test/for-docs/security/index.test.ts` (UserProfileDO/TeamDocDO ownership) is unrelated — leave it untouched (verify-only, no edit).
  - **Add `packages/mesh/test/for-docs/calls` to the "verify still green" set** — its `EditorClient` has **no** `onBeforeCall` override ([editor-client.ts:35](packages/mesh/test/for-docs/calls/editor-client.ts)), so it already exercises the **default** guard on the accept side with both a Worker caller (`SpellCheckWorker`→`handleSpellFindings`) and a DO caller (`DocumentDO`→`handleContentUpdate`). It must stay green.
  - Confirm the fix does **not** red `TestClient.onBeforeCall`+`super()` ([lumenize-client.test.ts:132-144](packages/mesh/test/lumenize-client.test.ts)) or the existing caller-accessor coverage ([call-context.test.ts:113-145](packages/mesh/test/call-context.test.ts)).
- [x] **Docs + JSDoc updated (enumerated, not "any page")** — reframe as caller-based at these named sites (`@check-example` guards code, not prose, and the grep term `Peer-to-peer` does **not** match this load-bearing prose, so they must be listed):
  - `LumenizeClient.onBeforeCall` JSDoc ([lumenize-client.ts:701-723](packages/mesh/src/lumenize-client.ts)) — currently "reject calls from other LumenizeClients … but allow calls that originated from this same client."
  - [lumenize-client.mdx:150-176](website/docs/mesh/lumenize-client.mdx) — the claim *"Calls originating from other LumenizeClients are rejected by default"* and its ✅/❌ bullets become **false** post-fix (DO-mediated fanout *originates* from another client yet is now accepted). Reword to caller-based; the "Opting In" override example stays valid (genuine *direct* peer calls still need the override).
  - [calls.mdx:13](website/docs/mesh/calls.mdx) — *"Client-to-client calls: Disabled by default"* stays true; add "**direct**" for precision.

## Testing anchors / gotchas
- **Split the fixtures by concern** — the foundation default belongs in its own package:
  - **#1/#2/#3 (foundation default) → [`packages/mesh/test/for-docs/calls/peer-guard.test.ts`](packages/mesh/test/for-docs/calls/peer-guard.test.ts)** (BUILT). **Home choice (diverged from the original `test-worker-and-dos.ts` pointer):** the `calls` mini-app already ships the full real-client harness (base `LumenizeClientGateway` = no-op fence; `EditorClient` with **no** `onBeforeCall` override = the default guard; `DocumentDO`; `SpellCheckWorker`), so reusing it meant adding just one fanout method + one test file. NOTE: the `main` project is **also** capable — its worker default-export routes `/gateway/…` via `routeDORequest({ prefix: 'gateway' })` explicitly "for e2e testing with Browser.WebSocket", and the `@lumenize/testing` `Browser` shim is a faithful WS router (NOT a mock; `lumenize-client.test.ts`'s hand-rolled `createMockWebSocketClass` is a per-file *unit* choice, not a ceiling) — homing there would just need a client fixture + a fanout DO method built. Both satisfy the Stage-2 intent: base Gateway (no aud-fence confound) + `createTestRefreshFunction` (a `@lumenize/mesh` export — **no `createNebulaTestToken`/nebula import**, mesh.md dep direction). #1 uses a NEW no-`newChain` fanout `DocumentDO.updatePreservingOrigin`; #2 is `lmz.call('LUMENIZE_CLIENT_GATEWAY', bob.lmz.instanceName!, …)` with distinct `instanceName`s; #3 is `SpellCheckWorker`→`handleSpellFindings`. **All 3 mutation-checks RUN + observed to flip** (#1↯`callChain[0]`, #2↯guard-removal, #3↯DO-only-allow).
  - **#4/#6 (override removal) → apps/nebula profile-store harness** — that's where `NebulaClient`/`SubscriberProbe` live; deleting their permissive overrides and staying green (fanout still delivered end-to-end) is the real-world proof the default suffices behind the `NebulaClientGateway` fence.
- The direct-client→client "blocked" assertion is a **negative** — anchor it with a same-connection barrier (a later DO-mediated push that IS delivered), not a `setTimeout` (testing.md § never `setTimeout`).
- `pkill -9 -f workerd` between pool-workers runs (workerd-zombie-hang).
- `apps/nebula` baseline lane is expectedly-red mid-turnover — verify the affected new/updated tests in isolation, not "whole lane green" (per the profile-store banner precedent).

## Not in scope
- Changing the Gateway's `onBeforeCallToClient` (the real boundary) — untouched.
- The base `LumenizeClientGateway` no-op default — that's the consumer's boundary to set; this task only fixes the client-side default.
- **`LumenizeWorker.onBeforeCall`'s origin-based `@example`** ([lumenize-worker.ts:120-134](packages/mesh/src/lumenize-worker.ts)) and its generated [FetchExecutorEntrypoint.md](website/docs/fetch/api/classes/FetchExecutorEntrypoint.md) — it *deliberately* checks `callChain[0]` ("only allow internal mesh calls, no client origin"), a genuinely different boundary from the client's direct-caller guard. **Leave it as-is** — bound the caller-based reframe to the `LumenizeClient` guard only. (Guard against a blind tree-wide `callChain[0]`→`.at(-1)` sweep flipping it into teaching an insecure pattern.)
