/**
 * A host node's `onBeforeCallToClient` — a hosted Client receives a node's call only if its holder
 * has passage into the node.
 *
 * The sender is the call's last hop, `callChain.at(-1)`, which the mesh stamps. A node's scope is
 * its name when that parses as one, so a Galaxy reaches a tab on one of its Stars (upward is free)
 * and a sibling Star does not (lateral). A node whose name is no scope, the `Profile`, passes. A
 * Client sender is not checked here, since a tab offers no scope: the receiving Client decides.
 * An envelope that names no sender is refused.
 *
 * A pure sync hook (envelope + connection info in, throw-or-return out), exercised directly. An
 * envelope with an empty chain is a branch no running system produces; a Client sender is one
 * `harness/scenarios/client-sender-passage.ts` drives live, where the receiving Client refuses it.
 * The Star and Galaxy senders are driven through a real host node in
 * `client-gateway-passage-delivery.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { NebulaDO } from '../../../src/index';
import type { CallEnvelope, GatewayConnectionInfo, NodeIdentity } from '@lumenize/mesh';

/** The hook is pure, so it can be invoked off the prototype with no DO construction. */
const gate = NebulaDO.prototype.onBeforeCallToClient;

const node = (bindingName: string, instanceName?: string): NodeIdentity =>
  ({ type: instanceName?.includes('/') ? 'LumenizeClient' : 'LumenizeDO', bindingName, instanceName });

function envelope(callChain: NodeIdentity[], originClaims?: Record<string, unknown>): CallEnvelope {
  return {
    version: 1,
    chain: [],
    callContext: {
      callChain,
      ...(originClaims ? { originAuth: { sub: 'origin-sub', claims: originClaims } } : {}),
    },
  } as unknown as CallEnvelope;
}

function tab(access: { authScope: string; scopeAdmin?: boolean }, aud = access.authScope): GatewayConnectionInfo {
  return { sub: 'tab-sub', bindingName: 'STAR', instanceName: `${aud}/tab-sub.t1`, claims: { aud, access } };
}

const run = (e: CallEnvelope, c: GatewayConnectionInfo) => () => gate.call({} as any, e, c);

const GALAXY = 'acme.crm';
const STAR_A = 'acme.crm.a';
const STAR_B = 'acme.crm.b';
const MEMBER_A = { authScope: STAR_A };

describe('a host node\'s onBeforeCallToClient — the tab\'s passage into the sender', () => {
  it('a Galaxy reaches a plain member\'s tab on one of its Stars, and a fresh chain needs no claims', () => {
    expect(run(envelope([node('GALAXY', GALAXY)]), tab(MEMBER_A))).not.toThrow();
  });

  it('a sibling Star is refused, by a message naming passage and both scopes', () => {
    expect(run(envelope([node('STAR', STAR_B)]), tab(MEMBER_A)))
      .toThrow(`No passage from "${STAR_A}" into "${STAR_B}"`);
  });

  it('a sender whose name is no scope passes — the Profile', () => {
    expect(run(envelope([node('PROFILE', crypto.randomUUID())]), tab(MEMBER_A))).not.toThrow();
  });

  it('an envelope that names no sender is refused', () => {
    // `buildOutgoingCallContext` always seeds a chain and a Client's server-side half seeds `[verifiedOrigin]`, so
    // no running system sends one; a hand-built envelope is the only way to reach this branch.
    expect(run(envelope([]), tab(MEMBER_A))).toThrow('Call to a client names no sender');
  });

  describe('a Client sender is left to the receiving Client', () => {
    const otherTab = node('STAR', `${STAR_B}/${crypto.randomUUID()}.t2`);

    it('a tab on a sibling Star passes the host node', () => {
      expect(run(envelope([otherTab], { aud: STAR_B }), tab(MEMBER_A))).not.toThrow();
    });

    it('a tab on the same Star passes the host node', () => {
      expect(run(envelope([otherTab], { aud: STAR_A }), tab(MEMBER_A))).not.toThrow();
    });

    it('a Client sender with no verified aud passes the host node', () => {
      expect(run(envelope([otherTab]), tab(MEMBER_A))).not.toThrow();
    });
  });

  // Passage reads the host's scope, the tab's `aud`, so the membership covering both Stars carries
  // no dominion from Star B's host over Star A (the host rule, ADR-015 and ADR-022).
  it('one galaxy admin\'s tab on a sibling Star is refused, though their scope covers both', () => {
    const GALAXY_ADMIN = { authScope: GALAXY, scopeAdmin: true };
    expect(run(envelope([node('STAR', STAR_A)]), tab(GALAXY_ADMIN, STAR_B)))
      .toThrow(`No passage from "${STAR_B}" into "${STAR_A}"`);
  });
});
