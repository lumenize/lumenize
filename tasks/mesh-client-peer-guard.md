# Mesh client peer-to-peer guard: check the immediate CALLER, not the ORIGIN

**Status**: **NEW (2026-07-14)** — a focused `@lumenize/mesh` framework fix, surfaced during the profile-store build (Larry's call). Ready for `/review-task`. Small + single-package, but it changes the **default security posture of the MIT foundation**, so it earns a review pass + a semver flag.

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

## The mechanism (empirically confirmed 2026-07-14, not just reasoned)
Instrumented `onBeforeCall` on a real cross-scope fanout push (profile-store headline test). The chain the receiving client sees:

```
callChain = [ LumenizeClient(origin = the writer client), LumenizeDO(the PROFILE DO) ]
            └ callChain[0] = origin client          └ callChain.at(-1) = the DO (the immediate caller)
```

- **DO-mediated fanout** → `callChain.at(-1).type === 'LumenizeDO'` (the DO appends itself as the caller; the Gateway is not a mesh participant, so it isn't in the chain). Also covers `svc.broadcast`'s tier path (caller = a `LumenizeWorker`) and multi-hop direct-delivery (caller = the final DO).
- **Direct client→client** (A calls the Gateway targeting B, no DO) → `callChain = [A]`, so `callChain.at(-1)` = **A, a `LumenizeClient`**.
- **Self fire-back** (a client's own `callAsync` result) → the DO fires it back, so `callChain.at(-1)` = the DO → allowed.

So the immediate caller cleanly separates the legitimate case (DO/Worker) from the risk (client).

## The fix (option b)
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
- **Remove the guard entirely (permissive default).** Legitimate and "enough rope," but the base `LumenizeClientGateway.onBeforeCallToClient` is a **no-op default**, so a base consumer overriding neither would have *fully open* client↔client `@mesh` calls. Option (b) keeps the base mesh secure-by-default without the footgun, and fixes a latent bug rather than deleting a feature. (If a future decision says direct client→client isn't worth a framework default at all, removal is the fallback.)
- **`newChain: true` on the fanout call.** It *would* dodge the client guard (origin becomes the DO), but it also nulls `originAuth` ([lumenize-client.ts buildClientOutgoingContext](packages/mesh/src/lumenize-client.ts) → `originAuth: undefined`), which **breaks the Gateway's aud check** — the boundary the Star fanout depends on (`broadcast.ts` deliberately does NOT `newChain` so pushes inherit the mutator's aud). Not a fix; it trades a client-guard override for a broken Gateway boundary.

## Blast radius
- `@lumenize/mesh` (MIT foundation) — affects **all** consumers' default client security posture. **Semver-worthy** — flag the next release (CLAUDE.md favors breaking changes over debt; this is a behavior change to a documented default).
- After the fix, the permissive `onBeforeCall` overrides in **`NebulaClient`** and in **test probes** become unnecessary — see the sub-decision below.
- ADR-007 context: `onBeforeCall` is part of the shared narrow comms + guards core; this refines its default, not the mechanism.

## Success criteria (capable-of-failing)
- [ ] **The default accepts DO-mediated fanout with NO override.** A client with the *default* `onBeforeCall` (no override) receives a DO fanout push (`handleResourceUpdate`). Mutation-check: revert the guard to `callChain[0]` and this reds.
- [ ] **The default still blocks a DIRECT client→client call.** Client A calls client B's `@mesh` method directly (via the Gateway, no DO in the chain); B, using the *default* guard, does NOT receive it (rejected). Capable-of-failing: remove the guard entirely and B receives it. (Build the fixture so the caller really is a client — `callChain.at(-1).type === 'LumenizeClient'`.)
- [ ] **No regression on self / fire-back paths** — a client's own `callAsync` result and multi-hop direct-delivery (caller = DO/Worker) are accepted.
- [ ] **`NebulaClient`'s permissive override is REMOVED** (it inherits the corrected default — which now blocks direct client→client, a tightening) OR explicitly kept with a documented reason. Verify no Nebula flow does direct client→client (the only client-push pattern is DO-mediated fanout, so removal should be safe + a real-world validation that the default now suffices). All mesh + nebula client suites stay green.
- [ ] **Test-probe overrides removed** — the profile-store `SubscriberProbe`'s `override onBeforeCall(): void {}` ([profile-subscribe.test.ts](apps/nebula/test/test-apps/baseline/profile-subscribe.test.ts)) and any other test-only permissive override are deleted; those suites still pass (proving the default now allows fanout end-to-end, incl. the `NebulaClientTest` real-client update path).
- [ ] **Existing guard tests updated** to the caller-based semantics — the ones asserting the origin-based behavior (`packages/mesh/test/lumenize-client.test.ts`, `packages/mesh/test/for-docs/security/index.test.ts`, plus a grep for `Peer-to-peer`/`onBeforeCall` across `packages/mesh/test` and `apps/nebula/test`).
- [ ] **Docs + JSDoc updated** — the `onBeforeCall` JSDoc (currently says "reject calls from other LumenizeClients … but allow calls that originated from this same client"), and any website mesh/security page describing the peer-to-peer default. Reframe as caller-based.

## Testing anchors / gotchas
- Reuse the profile-store harness pattern for a clean fixture: a plain `LumenizeClient` subclass with an `@mesh` receiver + `createNebulaTestToken`/`createTestRefreshFunction` → real Gateway → a DO fanout for the "accepted" case, and a client-to-client `lmz.call('<GATEWAY>', otherClientId, ctn().method())` for the "blocked" case.
- The direct-client→client "blocked" assertion is a **negative** — anchor it with a same-connection barrier (a later DO-mediated push that IS delivered), not a `setTimeout` (testing.md § never `setTimeout`).
- `pkill -9 -f workerd` between pool-workers runs (workerd-zombie-hang).
- `apps/nebula` baseline lane is expectedly-red mid-turnover — verify the affected new/updated tests in isolation, not "whole lane green" (per the profile-store banner precedent).

## Not in scope
- Changing the Gateway's `onBeforeCallToClient` (the real boundary) — untouched.
- The base `LumenizeClientGateway` no-op default — that's the consumer's boundary to set; this task only fixes the client-side default.
