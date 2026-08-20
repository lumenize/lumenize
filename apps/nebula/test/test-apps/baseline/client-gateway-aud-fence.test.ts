/**
 * `NebulaClientGateway.onBeforeCallToClient` — the OUTBOUND same-`aud` fence.
 *
 * 🚨 **This exists because `aud` stopped deciding passage, and that change must not be
 * over-applied into deleting the claim.** `requirePassage` now computes passage from the caller's
 * own `access.authScope`; this fence is the one place that still reads `aud`, and it is not
 * substitutable. Two browser tabs belonging to ONE Galaxy admin, open on sibling tenant Stars,
 * share `authScope` **and** `scopeAdmin` — so a fence written over those would deliver one
 * tenant's subscription updates into the other tenant's tab. Only `aud` distinguishes them, because
 * `aud` is precisely "which scope is this connection looking at".
 *
 * ⚠️ **The refusal branch had NO test before this file.** Every other reference to the fence was a
 * comment or the PROFILE early-return; a change that dropped the `aud` claim, or replaced the
 * comparison with `authScope`, would have gone green across the whole suite. That is the shape
 * `.claude/rules/calibration.md` §3 warns about — the guard whose absence nothing reports.
 *
 * A pure sync hook (envelope + connection info in, throw-or-return out), so it is exercised
 * directly here rather than through a socket — the same treatment `requirePassage`'s branch matrix
 * gets in `scope-isolation.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { NebulaClientGateway } from '../../../src/index';
import type { CallEnvelope, GatewayConnectionInfo } from '@lumenize/mesh';

/** The hook is pure, so it can be invoked off the prototype with no DO construction. */
const fence = NebulaClientGateway.prototype.onBeforeCallToClient;

function envelope(opts: { aud?: string; callerBinding?: string; access?: unknown }): CallEnvelope {
  const claims: Record<string, unknown> = {};
  if (opts.aud !== undefined) claims.aud = opts.aud;
  if (opts.access !== undefined) claims.access = opts.access;
  return {
    version: 1,
    chain: [],
    callContext: { callChain: [], state: {}, originAuth: { sub: 'origin-sub', claims } },
    ...(opts.callerBinding
      ? { metadata: { caller: { type: 'LumenizeDO', bindingName: opts.callerBinding, instanceName: 'x' } } }
      : {}),
  } as unknown as CallEnvelope;
}

function connection(aud: string | undefined, access?: unknown): GatewayConnectionInfo {
  const claims: Record<string, unknown> = {};
  if (aud !== undefined) claims.aud = aud;
  if (access !== undefined) claims.access = access;
  return { sub: 'conn-sub', bindingName: 'GATEWAY', instanceName: 'conn-sub.tab', claims };
}

const run = (e: CallEnvelope, c: GatewayConnectionInfo) => () => fence.call({} as any, e, c);

describe('NebulaClientGateway.onBeforeCallToClient — the outbound aud fence', () => {
  const TENANT_A = 'acme.app.tenant-a';
  const TENANT_B = 'acme.app.tenant-b';

  it('delivers a push whose origin aud matches the connection aud', () => {
    expect(run(envelope({ aud: TENANT_A }), connection(TENANT_A))).not.toThrow();
  });

  // 🔒 The property the whole fence exists for. Mutation: delete the comparison (or key it on
  // `access.authScope`) → this admits, and one tenant's updates land in another tenant's tab.
  it('REFUSES a push whose origin aud differs from the connection aud', () => {
    expect(run(envelope({ aud: TENANT_A }), connection(TENANT_B)))
      .toThrow('Active-scope mismatch on call to client');
  });

  // ⚠️ The case that makes `authScope` an unacceptable substitute — and it must CONSTRUCT the
  // claims, not describe them. An earlier version of this test omitted `access` "because the fence
  // must not consult it", which made it byte-identical to the one above: it demonstrated nothing
  // about substitutability while reading, in the run output, as if it did.
  //
  // Both envelopes below carry the SAME `access` — one Galaxy admin, two tabs on sibling tenant
  // Stars, identical `authScope` and identical `scopeAdmin`. A fence keyed on either of those
  // fields admits this delivery and leaks tenant A's updates into tenant B's tab. Only `aud`
  // separates them.
  it('REFUSES sibling-tenant delivery for ONE admin whose scope covers both', () => {
    const GALAXY_ADMIN = { authScope: 'acme.app', scopeAdmin: true };
    expect(
      run(
        envelope({ aud: TENANT_A, access: GALAXY_ADMIN }),
        connection(TENANT_B, GALAXY_ADMIN),
      ),
    ).toThrow('Active-scope mismatch on call to client');
  });

  // The positive control for the case above: the SAME admin, same `access`, delivering to a tab on
  // the scope the push actually came from. Without it, the refusal above would also be satisfied by
  // a fence that refused this admin outright.
  it('DELIVERS to that same admin when the tab is on the originating scope', () => {
    const GALAXY_ADMIN = { authScope: 'acme.app', scopeAdmin: true };
    expect(
      run(
        envelope({ aud: TENANT_A, access: GALAXY_ADMIN }),
        connection(TENANT_A, GALAXY_ADMIN),
      ),
    ).not.toThrow();
  });

  it('fails closed when the origin carries no aud at all', () => {
    expect(run(envelope({}), connection(TENANT_A)))
      .toThrow('Active-scope mismatch on call to client');
  });

  // The PROFILE-fence carve-out (ADR-012; tasks/archive/nebula-profile-store.md § Routing model): a push from the global
  // Profile DO carries PUBLIC fields only, and public profile read is OPEN, so cross-scope delivery
  // is intentional there. Kept beside the refusals so the exception cannot be mistaken for a hole.
  it('exempts a PROFILE push from the aud check (deliberate cross-scope delivery)', () => {
    expect(run(envelope({ aud: TENANT_A, callerBinding: 'PROFILE' }), connection(TENANT_B)))
      .not.toThrow();
  });

  it('does NOT exempt a non-PROFILE caller with mismatched aud', () => {
    expect(run(envelope({ aud: TENANT_A, callerBinding: 'STAR' }), connection(TENANT_B)))
      .toThrow('Active-scope mismatch on call to client');
  });
});
