/**
 * The `lmz.access-token.` WebSocket subprotocol — mesh owns both ends on the Nebula path.
 *
 * `WS_TOKEN_PREFIX` + `extractWebSocketToken` moved here from `@lumenize/auth` so the producer
 * (`lumenize-client.ts` `#connect`) and the consumer (`nebula-auth`'s router, Nebula's
 * entrypoint) share one definition instead of a never-re-sync copy between two ends of a live
 * protocol — where the failure mode is a silent 401 on WS upgrade.
 *
 * The `extractWebSocketToken` cases below are ported from `packages/auth/test/auth.test.ts`
 * (`@lumenize/auth - WebSocket Utilities`). They are kept because they feed a **hand-written
 * header** and so do NOT derive from the constant — a round-trip test would.
 */
import { describe, it, expect } from 'vitest';
import { WS_TOKEN_PREFIX, extractWebSocketToken } from '../src/gateway-messages';

describe('WS_TOKEN_PREFIX', () => {
  /**
   * ⚠️ Pinned as a LITERAL on purpose. A producer→consumer round-trip is **true by
   * construction** once both ends share this constant, so it cannot fail on the real hazard:
   * the value changing under already-deployed clients, and under the third-party integrators
   * `website/docs/mesh/security.mdx` teaches to hand-write it. Changing the constant is a
   * breaking protocol change; this test is what says so.
   */
  it('is exactly "lmz.access-token." — a published wire convention', () => {
    expect(WS_TOKEN_PREFIX).toBe('lmz.access-token.');
  });
});

describe('extractWebSocketToken', () => {
  it('extracts token from Sec-WebSocket-Protocol header', () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'lmz, lmz.access-token.my-jwt-token-here',
      },
    });

    expect(extractWebSocketToken(request)).toBe('my-jwt-token-here');
  });

  it('returns null when no Sec-WebSocket-Protocol header', () => {
    const request = new Request('http://localhost/ws', {
      headers: { Upgrade: 'websocket' },
    });

    expect(extractWebSocketToken(request)).toBeNull();
  });

  it('returns null when no token protocol present', () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'lmz, other-protocol',
      },
    });

    expect(extractWebSocketToken(request)).toBeNull();
  });

  it('handles token-only protocol header', () => {
    const request = new Request('http://localhost/ws', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': 'lmz.access-token.token-value',
      },
    });

    expect(extractWebSocketToken(request)).toBe('token-value');
  });
});
