/**
 * A fire-back whose transport fails logs which chain it was on and where it was going.
 *
 * **Why this tier and not `/live`:** the failure this line exists for, Cloudflare's
 * `Subrequest depth limit exceeded`, does not happen under local `wrangler dev`, and no scenario can
 * make a transport fail on demand. What is under test is the log line's content, which a direct
 * call to `fireResponse` with an unroutable return address produces as any transport failure would.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import { setDebugSink, clearDebugSink, type DebugLogOutput } from '@lumenize/debug';
import { fireResponse, type EnvelopeResponse } from '../src/lmz-api';
import type { CallContext, NodeIdentity } from '../src/types';

describe('a failed fire-back names its chain', () => {
  it('logs the chain it was on, ending at the answerer, and the address it was going to', async () => {
    const origin: NodeIdentity = { type: 'LumenizeClient', bindingName: 'STAR', instanceName: 'acme.crm.t1/alice.9f2c41aa' };
    const relay: NodeIdentity = { type: 'LumenizeWorker', bindingName: 'AUTH_FACADE' };
    const answerer: NodeIdentity = { type: 'LumenizeDO', bindingName: 'GALAXY', instanceName: 'acme.crm' };
    const inbound: CallContext = { callChain: [origin, relay] };
    // A binding the env does not declare, so the transport throws before any RPC is made.
    const response: EnvelopeResponse = {
      kind: 'mesh',
      returnAddr: { type: 'LumenizeWorker', bindingName: 'NO_SUCH_BINDING' },
      handler: preprocess([]),
    };

    const entries: DebugLogOutput[] = [];
    setDebugSink((e) => entries.push(e));
    try {
      await fireResponse(answerer, env, inbound, response, 'ok', false, 'Galaxy', 'callee');
    } finally {
      clearDebugSink();
    }

    const line = entries.find((e) => e.level === 'error'
      && e.message === 'Galaxy: fire-back transport to __handleResponse failed');
    expect(line, 'the transport failure is logged at error level').toBeDefined();
    const data = line!.data as { error: Error; to: string; callChain: string[] };
    expect(data.error).toBeInstanceOf(Error);
    expect(data.to).toBe('NO_SUCH_BINDING');
    expect(data.callChain).toEqual(['STAR/acme.crm.t1/alice.9f2c41aa', 'AUTH_FACADE', 'GALAXY/acme.crm']);
  });
});
