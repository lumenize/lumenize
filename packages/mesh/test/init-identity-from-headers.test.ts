/**
 * initIdentityFromHeaders — the fetch()-path identity stamp LumenizeDO.__initFromHeaders
 * composes (ADR-007 identity-on-every-entry-path). Pure function, so unit-testable here.
 */
import { describe, it, expect } from 'vitest';
import { initIdentityFromHeaders } from '../src/lmz-api';

const headers = (h: Record<string, string>) => new Headers(h);

describe('initIdentityFromHeaders', () => {
  it('stamps bindingName + instanceName from the routed headers', () => {
    const captured: Array<{ bindingName?: string; instanceName?: string }> = [];
    const lmz = { __init: (o: { bindingName?: string; instanceName?: string }) => captured.push(o) };
    const r = initIdentityFromHeaders(
      headers({
        'x-lumenize-do-binding-name': 'DEV_CONTAINER',
        'x-lumenize-do-instance-name-or-id': 'acme.app.dev',
      }),
      lmz,
    );
    expect(r).toBeUndefined();
    expect(captured).toEqual([{ bindingName: 'DEV_CONTAINER', instanceName: 'acme.app.dev' }]);
  });

  it('rejects a 64-hex DO id with a 400 (name == routing-key invariant) and never stamps', async () => {
    let called = false;
    const lmz = { __init: () => { called = true; } };
    const r = initIdentityFromHeaders(
      headers({ 'x-lumenize-do-instance-name-or-id': '0'.repeat(64) }),
      lmz,
      'MyNode',
    );
    expect(r).toBeInstanceOf(Response);
    expect(r!.status).toBe(400);
    expect(await r!.text()).toContain('MyNode requires instanceName');
    expect(called).toBe(false);
  });

  it('surfaces an __init binding/name mismatch as a 500', async () => {
    const lmz = { __init: () => { throw new Error('DO instance name mismatch: stored x but received y'); } };
    const r = initIdentityFromHeaders(headers({ 'x-lumenize-do-binding-name': 'X' }), lmz);
    expect(r!.status).toBe(500);
    expect(await r!.text()).toContain('instance name mismatch');
  });

  it('is a no-op (undefined, __init never called) when no routing headers are present', () => {
    let called = false;
    const lmz = { __init: () => { called = true; } };
    const r = initIdentityFromHeaders(headers({ 'x-unrelated': 'y' }), lmz);
    expect(r).toBeUndefined();
    expect(called).toBe(false);
  });
});
