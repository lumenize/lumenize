import { describe, it, expect } from 'vitest';
import { instrumentDOProject } from '../src/instrument-do-project';

describe('instrumentDOProject', () => {
  it('auto-detects single DO class (zero config)', () => {
    class MyDO {
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
  
  it('throws helpful error when multiple DO classes found', () => {
    class FirstDO {}
    class SecondDO {}
    
    const sourceModule = {
      FirstDO,
      SecondDO,
      default: {}
    };
    
    expect(() => {
      instrumentDOProject(sourceModule);
    }).toThrow(/Found multiple class exports: FirstDO, SecondDO/);
    
    expect(() => {
      instrumentDOProject(sourceModule);
    }).toThrow(/doClassNames: \['FirstDO', 'SecondDO'\]/);
  });
  
  it('works with explicit config for multiple DOs', () => {
    class FirstDO {}
    class SecondDO {}
    
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
  
  it('throws error if DO class not found in source module', () => {
    const sourceModule = {
      SomethingElse: class {},
      default: {}
    };
    
    expect(() => {
      instrumentDOProject({
        sourceModule,
        doClassNames: ['NonExistentDO']
      });
    }).toThrow(/DO class 'NonExistentDO' not found/);
  });
  
  it('handles multiple DO classes', () => {
    class FirstDO {}
    class SecondDO {}
    
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
  
  it('works without a default worker export', () => {
    class MockDO {}
    
    const sourceModule = {
      MockDO,
      // No default export
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
      MockDO: class {},
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
    class MockDO {}
    
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
});
