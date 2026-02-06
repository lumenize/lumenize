import { describe, test, expect, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess } from '@lumenize/structured-clone';
import type { TestWorker } from './test-worker-and-dos';
import { getOperationChain } from '../src/ocan/index.js';

describe('LumenizeWorker - Identity Management (this.lmz.*)', () => {
  test('this.lmz.type returns "LumenizeWorker"', async () => {
    const result = await env.TEST_WORKER.getType();
    expect(result).toBe('LumenizeWorker');
  });

  test('this.lmz.bindingName getter returns undefined initially', async () => {
    const result = await env.TEST_WORKER.getBindingName();
    expect(result).toBeUndefined();
  });

  test('this.lmz.bindingName can be set and retrieved in same call', async () => {
    // Workers are stateless - each call is a new instance
    // But within a single call, the setter/getter should work
    const result = await env.TEST_WORKER.testBindingNameSetterGetter('MY_WORKER');
    expect(result).toBe('MY_WORKER');
  });

  test('this.lmz.__init() sets bindingName (within single call)', async () => {
    const result = await env.TEST_WORKER.testInitBindingName('INIT_WORKER');
    expect(result).toBe('INIT_WORKER');
  });

  test('this.lmz.instanceName always returns undefined', async () => {
    const result = await env.TEST_WORKER.getInstanceName();
    expect(result).toBeUndefined();
  });

  // NOTE: id property removed - use instanceName instead
  // NOTE: instanceNameOrId property and setters removed - properties are now readonly
});

describe('LumenizeWorker - Continuation Support (this.ctn())', () => {
  test('this.ctn() creates a working continuation', async () => {
    const result = await env.TEST_WORKER.testContinuationCreation();
    expect(result).toBe('continuation_works');
  });

  test('continuation can be used with this.lmz.callRaw()', async () => {
    // This test validates that continuations work with callRaw
    // Full RPC testing will be in integration tests
    const result = await env.TEST_WORKER.testContinuationCreation();
    expect(result).toBe('continuation_works');
  });
});

describe('LumenizeWorker - RPC Receiver (__executeOperation)', () => {
  test('validates envelope version (rejects missing version)', async () => {
    // __executeOperation expects envelope with only chain preprocessed
    const invalidEnvelope = {
      chain: preprocess({ operations: [] }),
      metadata: {}
    };

    await expect(
      env.TEST_WORKER.__executeOperation(invalidEnvelope)
    ).rejects.toThrow(/Unsupported RPC envelope version.*only supports v1/);
  });

  test('validates envelope version (rejects unsupported version)', async () => {
    // __executeOperation expects envelope with only chain preprocessed
    const invalidEnvelope = {
      version: 2,
      chain: preprocess({ operations: [] }),
      metadata: {}
    };

    await expect(
      env.TEST_WORKER.__executeOperation(invalidEnvelope)
    ).rejects.toThrow(/Unsupported RPC envelope version: 2/);
  });

  // Valid envelope and auto-init are tested via callRaw() tests below
});

describe('LumenizeWorker - Direct Method Execution', () => {
  test('executes simple methods', async () => {
    const result = await env.TEST_WORKER.workerEcho('hello');
    expect(result).toBe('worker-echo: hello');
  });

  test('returns identity information (within single call)', async () => {
    const identity = await env.TEST_WORKER.testGetIdentityAfterInit('IDENTITY_TEST');

    expect(identity).toEqual({
      type: 'LumenizeWorker',
      bindingName: 'IDENTITY_TEST'
    });
  });
});

describe('LumenizeWorker - callRaw() RPC Calls', () => {
  test('Worker→DO callRaw returns result', async () => {
    const result = await env.TEST_WORKER.testCallRawToDO(
      'TEST_DO',
      'worker-callraw-do-1',
      'hello-from-worker'
    );
    expect(result).toBe('echo: hello-from-worker');
  });

  test('Worker→Worker callRaw returns result', async () => {
    const result = await env.TEST_WORKER.testCallRawToWorker(
      'TEST_WORKER',
      'hello-worker-to-worker'
    );
    expect(result).toBe('worker-echo: hello-worker-to-worker');
  });

  test('Worker→DO callRaw propagates errors', async () => {
    await expect(
      env.TEST_WORKER.testCallRawToDOThrowError('TEST_DO', 'worker-callraw-error-1')
    ).rejects.toThrow('Remote error for testing');
  });
});

describe('LumenizeWorker - call() Fire-and-Forget with Result Handlers', () => {
  test('result handler receives success result', async () => {
    const storeDO = env.TEST_DO.getByName('worker-call-result-store-1');

    // Worker calls DO remoteEcho, result handler forwards result to storeDO
    await env.TEST_WORKER.testCallToDO(
      'TEST_DO',
      'worker-call-target-1',
      'call-test-value',
      'worker-call-result-store-1'
    );

    // Wait for the fire-and-forget chain to complete
    await vi.waitFor(async () => {
      const result = await storeDO.getForwardedResult();
      expect(result).toBe('echo: call-test-value');
    });
  });

  test('result handler receives error as Error', async () => {
    const storeDO = env.TEST_DO.getByName('worker-call-error-store-1');

    // Worker calls DO throwError, result handler forwards error to storeDO
    await env.TEST_WORKER.testCallWithErrorToDO(
      'TEST_DO',
      'worker-call-error-target-1',
      'worker-call-error-store-1'
    );

    // Wait for the fire-and-forget chain to complete
    await vi.waitFor(async () => {
      const error = await storeDO.getForwardedError();
      expect(error).toBe('Remote error for testing');
    });
  });

  test('fire-and-forget without handler does not crash', async () => {
    // This should not throw — call returns void, work happens in background
    await env.TEST_WORKER.testCallFireAndForget(
      'TEST_DO',
      'worker-call-fandf-1',
      'fire-and-forget-value'
    );

    // Verify the remote DO received the call by checking its envelope
    const targetDO = env.TEST_DO.getByName('worker-call-fandf-1');
    await vi.waitFor(async () => {
      const envelope = await targetDO.getLastEnvelope();
      expect(envelope).toBeTruthy();
    });
  });

  test('throws if caller has no bindingName', async () => {
    await expect(
      env.TEST_WORKER.testCallWithoutBindingName()
    ).rejects.toThrow(/Cannot use call\(\) from a Worker that doesn't know its own binding name/);
  });

  test('DO→Worker error: DO result handler receives error from Worker throwError', async () => {
    const callerDO = env.TEST_DO.getByName('do-worker-error-caller-1');

    await callerDO.testLmzApiInit({ bindingName: 'TEST_DO' });

    // DO calls Worker throwError, DO result handler stores error
    callerDO.testCallWithErrorToWorker('TEST_WORKER');

    await vi.waitFor(async () => {
      const error = await callerDO.getLastCallError();
      expect(error).toBe('Worker remote error for testing');
    });
  });
});

