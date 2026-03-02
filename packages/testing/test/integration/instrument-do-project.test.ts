import { describe, it, expect } from 'vitest';
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { instrumentDOProject } from '../../src/instrument-do-project';

describe('instrumentDOProject', () => {
  it('auto-detects single DO class (zero config)', () => {
    class MyDO extends DurableObject {
      increment() { return 42; }
    }

    const sourceModule = {
      MyDO,
      default: {}
    };

    // Simple form - just pass sourceModule
    const { worker, dos } = instrumentDOProject(sourceModule);

    expect(dos.MyDO).toBeDefined();
    expect(worker).toBeDefined();
  });

  it('auto-detects multiple DO classes without requiring explicit config', () => {
    class FirstDO extends DurableObject {}
    class SecondDO extends DurableObject {}

    const sourceModule = {
      FirstDO,
      SecondDO,
      default: {}
    };

    // With prototype walking, multiple DOs are auto-detected — no error
    const { dos } = instrumentDOProject(sourceModule);

    expect(dos.FirstDO).toBeDefined();
    expect(dos.SecondDO).toBeDefined();
  });

  it('auto-detects DOs when mixed with WorkerEntrypoint exports', () => {
    class MyDO extends DurableObject {}
    class MyWorker extends WorkerEntrypoint {}

    const sourceModule = {
      MyDO,
      MyWorker,
      default: {}
    };

    // Auto-detection distinguishes DOs from WorkerEntrypoints
    const result = instrumentDOProject(sourceModule);

    // DO is wrapped and in dos
    expect(result.dos.MyDO).toBeDefined();
    // WorkerEntrypoint is passed through unwrapped
    expect(result.MyWorker).toBe(MyWorker);
    // WorkerEntrypoint is NOT in dos
    expect(result.dos.MyWorker).toBeUndefined();
  });

  it('passes through non-DO class exports on result object', () => {
    class DocDO extends DurableObject {}
    class AuthDO extends DurableObject {}
    class SpellCheckWorker extends WorkerEntrypoint {}
    class AnalyticsWorker extends WorkerEntrypoint {}

    const sourceModule = {
      DocDO,
      AuthDO,
      SpellCheckWorker,
      AnalyticsWorker,
      default: {}
    };

    const result = instrumentDOProject(sourceModule);

    // DOs are wrapped and available in dos and as direct properties
    expect(result.dos.DocDO).toBeDefined();
    expect(result.dos.AuthDO).toBeDefined();
    expect(result.DocDO).toBe(result.dos.DocDO);
    expect(result.AuthDO).toBe(result.dos.AuthDO);

    // Non-DO classes are passed through unwrapped as direct properties
    expect(result.SpellCheckWorker).toBe(SpellCheckWorker);
    expect(result.AnalyticsWorker).toBe(AnalyticsWorker);
  });

  it('throws when no DO classes found but non-DO classes exist', () => {
    class SomeWorker extends WorkerEntrypoint {}

    const sourceModule = {
      SomeWorker,
      default: {}
    };

    expect(() => {
      instrumentDOProject(sourceModule);
    }).toThrow(/No Durable Object classes found/);

    expect(() => {
      instrumentDOProject(sourceModule);
    }).toThrow(/Found non-DO class exports: SomeWorker/);
  });

  it('throws helpful error when no class exports found', () => {
    const sourceModule = {
      someUtility: () => {},
      CONSTANT: 42,
      default: {}
    };

    expect(() => {
      instrumentDOProject(sourceModule);
    }).toThrow(/No class exports found in sourceModule/);
  });

  it('works with explicit config for multiple DOs', () => {
    class FirstDO extends DurableObject {}
    class SecondDO extends DurableObject {}

    const sourceModule = {
      FirstDO,
      SecondDO,
      default: {}
    };

    const { dos } = instrumentDOProject({
      sourceModule,
      doClassNames: ['FirstDO', 'SecondDO']
    });

    expect(dos.FirstDO).toBeDefined();
    expect(dos.SecondDO).toBeDefined();
  });

  it('explicit config passes through non-specified classes', () => {
    class MyDO extends DurableObject {}
    class MyWorker extends WorkerEntrypoint {}

    const sourceModule = {
      MyDO,
      MyWorker,
      default: {}
    };

    const result = instrumentDOProject({
      sourceModule,
      doClassNames: ['MyDO']
    });

    // Specified DO is wrapped
    expect(result.dos.MyDO).toBeDefined();
    // Non-specified class is passed through
    expect(result.MyWorker).toBe(MyWorker);
  });

  it('throws error if DO class not found in source module', () => {
    const sourceModule = {
      SomethingElse: class extends DurableObject {},
      default: {}
    };

    expect(() => {
      instrumentDOProject({
        sourceModule,
        doClassNames: ['NonExistentDO']
      });
    }).toThrow(/DO class 'NonExistentDO' not found/);
  });

  it('works without a default worker export', () => {
    class MockDO extends DurableObject {}

    const sourceModule = {
      MockDO,
    };

    const { worker, dos } = instrumentDOProject({
      sourceModule,
      doClassNames: ['MockDO']
    });

    expect(dos.MockDO).toBeDefined();
    expect(worker).toBeDefined();
    expect(worker.fetch).toBeDefined();
  });

  it('preserves worker event handlers (scheduled, queue, email, etc.)', () => {
    const mockScheduled = async () => {};
    const mockQueue = async () => {};
    const mockEmail = async () => {};

    const mockWorker = {
      async fetch() { return new Response('ok'); },
      scheduled: mockScheduled,
      queue: mockQueue,
      email: mockEmail
    };

    const sourceModule = {
      MockDO: class extends DurableObject {},
      default: mockWorker
    };

    const { worker } = instrumentDOProject({
      sourceModule,
      doClassNames: ['MockDO']
    });

    expect(worker.scheduled).toBe(mockScheduled);
    expect(worker.queue).toBe(mockQueue);
    expect(worker.email).toBe(mockEmail);
  });

  it('supports custom RPC prefix', () => {
    class MockDO extends DurableObject {}

    const sourceModule = {
      MockDO,
      default: {}
    };

    // Should not throw with custom prefix
    const { worker } = instrumentDOProject({
      sourceModule,
      doClassNames: ['MockDO'],
      prefix: '/custom-rpc'
    });

    expect(worker).toBeDefined();
  });

  it('ignores non-class function exports', () => {
    class MyDO extends DurableObject {}

    const sourceModule = {
      MyDO,
      helperFunction: () => 'hello',
      CONSTANT: 42,
      default: {}
    };

    const result = instrumentDOProject(sourceModule);

    // DO is detected and wrapped
    expect(result.dos.MyDO).toBeDefined();
    // Non-class exports are not passed through (only classes are)
    expect(result.helperFunction).toBeUndefined();
    expect(result.CONSTANT).toBeUndefined();
  });
});
