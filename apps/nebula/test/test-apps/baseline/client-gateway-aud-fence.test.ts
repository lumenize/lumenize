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

function envelope(opts: { aud?: string; callerBinding?: string }): CallEnvelope {
  const claims: Record<string, unknown> = {};
  if (opts.aud !== undefined) claims.aud = opts.aud;
  return {
    version: 1,
    chain: [],
    callContext: { callChain: [], state: {}, originAuth: { sub: 'origin-sub', claims } },
    ...(opts.callerBinding
      ? { metadata: { caller: { type: 'LumenizeDO', bindingName: opts.callerBinding, instanceName: 'x' } } }
      : {}),
  } as unknown as CallEnvelope;
}

function connection(aud: string | undefined): GatewayConnectionInfo {
  return {
    sub: 'conn-sub', bindingName: 'GATEWAY', instanceName: 'conn-sub.tab',
    claims: aud === undefined ? {} : { aud },
  };
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

  // ⚠️ The case that makes `authScope` an unacceptable substitute, stated as a test rather than as
  // a comment: these two connections belong to the SAME Galaxy admin — identical `authScope`,
  // identical `scopeAdmin` — and differ only in the scope each tab is looking at. A fence keyed on
  // the claim that decides passage would admit this; `aud` is what refuses it.
  it('REFUSES sibling-tenant delivery for ONE admin whose scope covers both', () => {
    // Both tabs would carry `access: { authScope: 'acme.app', scopeAdmin: true }` — deliberately
    // omitted, because the fence must not consult it. Only the `aud` values differ.
    expect(run(envelope({ aud: TENANT_A }), connection(TENANT_B)))
      .toThrow('Active-scope mismatch on call to client');
  });

  it('fails closed when the origin carries no aud at all', () => {
    expect(run(envelope({}), connection(TENANT_A)))
      .toThrow('Active-scope mismatch on call to client');
  });

  // The PROFILE-fence carve-out (tasks/nebula-profile-store.md § Routing): a push from the global
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
