import { describe, it, expect, vi } from 'vitest';
import { testDOProject } from '@lumenize/testing';

/**
 * Comprehensive Testing Suite for @lumenize/testing
 * 
 * This file provides thorough validation of all features and edge cases
 * in the @lumenize/testing library. It focuses on happy-path testing
 * with comprehensive coverage of:
 * - All DO access patterns and edge cases
 * - Complete instance proxy functionality 
 * - Three-method API validation
 * - Map serialization with structured clone
 * - DO instance isolation
 * - Registry tracking and management
 * 
 * This test suite will eventually be migrated to the main @lumenize/testing
 * package for proper CI/CD integration.
 */
describe('Comprehensive @lumenize/testing Validation', () => {

  it('enables instance proxy access to DO internals', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'instance-test-example');
      
      // Test initial empty storage
      const initialStorage = await instance.ctx.storage.list();
      expect(initialStorage).toBeInstanceOf(Map);
      expect(initialStorage.size).toBe(0);
      
      // Test storage operations through instance proxy
      await instance.ctx.storage.put('test-key', 'test-value');
      const retrievedValue = await instance.ctx.storage.get('test-key');
      expect(retrievedValue).toBe('test-value');
      
      // Test different data types
      await instance.ctx.storage.put('number-key', 42);
      await instance.ctx.storage.put('object-key', { test: 'data' });
      
      const numberValue = await instance.ctx.storage.get('number-key');
      const objectValue = await instance.ctx.storage.get('object-key');
      expect(numberValue).toBe(42);
      expect(objectValue).toEqual({ test: 'data' });
      
      // Test storage delete
      await instance.ctx.storage.delete('test-key');
      const deletedValue = await instance.ctx.storage.get('test-key');
      expect(deletedValue).toBeUndefined();
      
    });
  });

  it('properly serializes Maps with structured clone', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'serialization-test-instance');
      
      // Put test data into storage
      await instance.ctx.storage.put('number-key', 42);
      await instance.ctx.storage.put('object-key', { test: 'data' });
      
      // Test that storage.list() returns proper Map with structured clone
      const storageList = await instance.ctx.storage.list();
      expect(storageList).toBeInstanceOf(Map);
      expect(storageList.size).toBe(2);
      expect(storageList.get('number-key')).toBe(42);
      expect(storageList.get('object-key')).toEqual({ test: 'data' });
      expect([...storageList.keys()]).toContain('number-key');
      expect([...storageList.keys()]).toContain('object-key');
      
    });
  });

  it('ensures storage isolation between DO instances', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance1 = instances('MY_DO', 'instance1');
      const instance2 = instances('MY_DO', 'instance2');
      
      // Store data in each instance
      await instance1.ctx.storage.put('instance1-data', 'value1');
      await instance2.ctx.storage.put('instance2-data', 'value2');
      
      // Verify isolation - data should not cross between instances
      const instance1CrossCheck = await instance1.ctx.storage.get('instance2-data');
      const instance2CrossCheck = await instance2.ctx.storage.get('instance1-data');
      expect(instance1CrossCheck).toBeUndefined();
      expect(instance2CrossCheck).toBeUndefined();
      
      // Verify each instance has its own data
      const instance1OwnData = await instance1.ctx.storage.get('instance1-data');
      const instance2OwnData = await instance2.ctx.storage.get('instance2-data');
      expect(instance1OwnData).toBe('value1');
      expect(instance2OwnData).toBe('value2');
      
    });
  });
  });

  it('tracks instances in registry correctly', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Create multiple instances
      await SELF.fetch('https://example.com/my-do/one/increment');
      await SELF.fetch('https://example.com/my-do/two/increment');
      await SELF.fetch('https://example.com/my-do/three/increment');
      
      // Check registry tracking
      const allInstances = instances.list();
      expect(allInstances.length).toBe(3);
      
      const myDOInstances = instances.list('MY_DO');
      expect(myDOInstances.length).toBe(3);
      
      // Verify all instances have instance, bindingName, and name properties
      for (const instance of myDOInstances) {
        expect(instance.bindingName).toBe('MY_DO');
        expect(instance.instance).toBeDefined();
        expect(['one', 'two', 'three'].includes(instance.name)).toBe(true);
      }
      
    });
  });

  it('supports all structured clone types in storage operations', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'structured-clone-test');
      
      // Test Date objects
      const testDate = new Date('2025-09-19T10:30:00.000Z');
      await instance.ctx.storage.put('date-key', testDate);
      const retrievedDate = await instance.ctx.storage.get('date-key');
      expect(retrievedDate).toBeInstanceOf(Date);
      expect(retrievedDate.getTime()).toBe(testDate.getTime());
      expect(retrievedDate.toISOString()).toBe('2025-09-19T10:30:00.000Z');
      
      // Test Set objects
      const testSet = new Set(['apple', 'banana', 'cherry', 42, true]);
      await instance.ctx.storage.put('set-key', testSet);
      const retrievedSet = await instance.ctx.storage.get('set-key');
      expect(retrievedSet).toBeInstanceOf(Set);
      expect(retrievedSet.size).toBe(5);
      expect(retrievedSet.has('apple')).toBe(true);
      expect(retrievedSet.has('banana')).toBe(true);
      expect(retrievedSet.has('cherry')).toBe(true);
      expect(retrievedSet.has(42)).toBe(true);
      expect(retrievedSet.has(true)).toBe(true);
      expect(retrievedSet.has('missing')).toBe(false);
      
      // Test Map objects (we already tested basic Maps, let's test complex ones)
      const testMap = new Map<any, any>([
        ['string-key', 'string-value'],
        [42, 'number-key'],
        [true, 'boolean-key'],
        [{ nested: 'object' }, 'object-key-value'],
        ['array-value', [1, 2, 3, { deep: 'nested' }]]
      ]);
      await instance.ctx.storage.put('complex-map-key', testMap);
      const retrievedMap = await instance.ctx.storage.get('complex-map-key');
      expect(retrievedMap).toBeInstanceOf(Map);
      expect(retrievedMap.size).toBe(5);
      expect(retrievedMap.get('string-key')).toBe('string-value');
      expect(retrievedMap.get(42)).toBe('number-key');
      expect(retrievedMap.get(true)).toBe('boolean-key');
      expect(retrievedMap.get('array-value')).toEqual([1, 2, 3, { deep: 'nested' }]);
      
      // Test ArrayBuffer and TypedArrays
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setInt32(0, 42, true); // little endian
      view.setFloat64(8, 3.14159, true);
      
      await instance.ctx.storage.put('arraybuffer-key', buffer);
      const retrievedBuffer = await instance.ctx.storage.get('arraybuffer-key');
      expect(retrievedBuffer).toBeInstanceOf(ArrayBuffer);
      expect(retrievedBuffer.byteLength).toBe(16);
      
      const retrievedView = new DataView(retrievedBuffer);
      expect(retrievedView.getInt32(0, true)).toBe(42);
      expect(retrievedView.getFloat64(8, true)).toBeCloseTo(3.14159);
      
      // Test Uint8Array
      const uint8Array = new Uint8Array([1, 2, 3, 4, 5, 255]);
      await instance.ctx.storage.put('uint8array-key', uint8Array);
      const retrievedUint8 = await instance.ctx.storage.get('uint8array-key');
      expect(retrievedUint8).toBeInstanceOf(Uint8Array);
      expect(retrievedUint8.length).toBe(6);
      expect(Array.from(retrievedUint8)).toEqual([1, 2, 3, 4, 5, 255]);
      
      // Test Int32Array  
      const int32Array = new Int32Array([-1000, 0, 1000, 2147483647, -2147483648]);
      await instance.ctx.storage.put('int32array-key', int32Array);
      const retrievedInt32 = await instance.ctx.storage.get('int32array-key');
      expect(retrievedInt32).toBeInstanceOf(Int32Array);
      expect(retrievedInt32.length).toBe(5);
      expect(Array.from(retrievedInt32)).toEqual([-1000, 0, 1000, 2147483647, -2147483648]);
      
      // Test Float64Array
      const float64Array = new Float64Array([3.14159, -2.71828, Number.MAX_VALUE, Number.MIN_VALUE]);
      await instance.ctx.storage.put('float64array-key', float64Array);
      const retrievedFloat64 = await instance.ctx.storage.get('float64array-key');
      expect(retrievedFloat64).toBeInstanceOf(Float64Array);
      expect(retrievedFloat64.length).toBe(4);
      expect(retrievedFloat64[0]).toBeCloseTo(3.14159);
      expect(retrievedFloat64[1]).toBeCloseTo(-2.71828);
      expect(retrievedFloat64[2]).toBe(Number.MAX_VALUE);
      expect(retrievedFloat64[3]).toBe(Number.MIN_VALUE);
      
      // Test RegExp objects
      const testRegex = /^test[0-9]+$/gi;
      await instance.ctx.storage.put('regex-key', testRegex);
      const retrievedRegex = await instance.ctx.storage.get('regex-key');
      expect(retrievedRegex).toBeInstanceOf(RegExp);
      expect(retrievedRegex.source).toBe('^test[0-9]+$');
      expect(retrievedRegex.flags).toBe('gi');
      expect(retrievedRegex.test('TEST123')).toBe(true);
      expect(retrievedRegex.test('nottest')).toBe(false);
      
      // Test deeply nested structures combining multiple types
      const complexTestDate = new Date('2024-01-01T00:00:00.000Z');
      const complexStructure = {
        metadata: {
          created: complexTestDate,
          tags: new Set(['important', 'production', 'v2']),
          config: new Map<string, any>([
            ['timeout', 5000],
            ['retries', 3],
            ['enabled', true]
          ])
        },
        data: {
          buffer: new Uint8Array([72, 101, 108, 108, 111]), // "Hello" in UTF-8
          measurements: new Float64Array([1.1, 2.2, 3.3]),
          pattern: /^\w+@\w+\.\w+$/i
        },
        arrays: [
          [1, 2, 3],
          new Set([4, 5, 6]),
          new Map([['nested', 'value']])
        ]
      };
      
      await instance.ctx.storage.put('complex-structure', complexStructure);
      const retrievedComplex = await instance.ctx.storage.get('complex-structure');
      
      // Verify the complex structure maintains all types
      expect(retrievedComplex.metadata.created).toBeInstanceOf(Date);
      expect(retrievedComplex.metadata.created.getTime()).toBe(complexTestDate.getTime());
      expect(retrievedComplex.metadata.tags).toBeInstanceOf(Set);
      expect(retrievedComplex.metadata.tags.has('production')).toBe(true);
      expect(retrievedComplex.metadata.config).toBeInstanceOf(Map);
      expect(retrievedComplex.metadata.config.get('timeout')).toBe(5000);
      expect(retrievedComplex.data.buffer).toBeInstanceOf(Uint8Array);
      expect(Array.from(retrievedComplex.data.buffer)).toEqual([72, 101, 108, 108, 111]);
      expect(retrievedComplex.data.measurements).toBeInstanceOf(Float64Array);
      expect(retrievedComplex.data.measurements[0]).toBeCloseTo(1.1);
      expect(retrievedComplex.data.pattern).toBeInstanceOf(RegExp);
      expect(retrievedComplex.data.pattern.test('user@example.com')).toBe(true);
      expect(retrievedComplex.arrays[1]).toBeInstanceOf(Set);
      expect(retrievedComplex.arrays[2]).toBeInstanceOf(Map);
      
      // Verify storage.list() correctly handles all these types
      const allStorageData = await instance.ctx.storage.list();
      expect(allStorageData).toBeInstanceOf(Map);
      expect(allStorageData.get('date-key')).toBeInstanceOf(Date);
      expect(allStorageData.get('set-key')).toBeInstanceOf(Set);
      expect(allStorageData.get('complex-map-key')).toBeInstanceOf(Map);
      expect(allStorageData.get('arraybuffer-key')).toBeInstanceOf(ArrayBuffer);
      expect(allStorageData.get('uint8array-key')).toBeInstanceOf(Uint8Array);
      expect(allStorageData.get('regex-key')).toBeInstanceOf(RegExp);
      
    });
  });

  it('handles circular object references correctly', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'circular-test');
      
      // Create a circular object structure
      const circularObj: any = {
        name: 'parent',
        data: [1, 2, 3],
        metadata: {
          type: 'circular-test',
          timestamp: new Date('2024-01-01T00:00:00.000Z')
        }
      };
      
      // Create the circular reference
      circularObj.self = circularObj;
      circularObj.metadata.parent = circularObj;
      
      // Test what happens when we try to store a circular object
      await instance.ctx.storage.put('circular-key', circularObj);
      
      // The structured clone algorithm successfully handles circular references!
      const retrievedCircular = await instance.ctx.storage.get('circular-key');
      
      // Verify the basic structure is preserved
      expect(retrievedCircular.name).toBe('parent');
      expect(retrievedCircular.data).toEqual([1, 2, 3]);
      expect(retrievedCircular.metadata.type).toBe('circular-test');
      expect(retrievedCircular.metadata.timestamp).toBeInstanceOf(Date);
      
      // Verify circular references are properly preserved
      expect(retrievedCircular.self).toBeDefined();
      expect(retrievedCircular.metadata.parent).toBeDefined();
      
      // Test that circular references point back to the correct objects
      expect(retrievedCircular.self.name).toBe('parent');
      expect(retrievedCircular.metadata.parent.name).toBe('parent');
      
      // Critical test: circular references should be preserved as true object references
      expect(retrievedCircular.self).toBe(retrievedCircular);
      expect(retrievedCircular.metadata.parent).toBe(retrievedCircular);
      
      // Test nested circular reference integrity
      expect(retrievedCircular.self.metadata.parent).toBe(retrievedCircular);
      expect(retrievedCircular.metadata.parent.self).toBe(retrievedCircular);
      
    });
  });

  it('demonstrates Error serialization with structured clone', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'error-test');
      
      // First, let's test Error serialization through structured clone
      // Structured clone only preserves message/stack from Error objects
      // Custom properties like 'code' are lost during serialization
      const customError = new Error('Test error message');
      customError.name = 'CustomTestError';
      (customError as any).code = 'TEST_ERROR_CODE';
      (customError as any).metadata = {
        timestamp: new Date(),
        source: 'test-suite',
        details: { attempt: 1, retryable: false }
      };
      
      // Store the error object to see if structured clone preserves it
      await instance.ctx.storage.put('error-object', customError);
      const retrievedError = await instance.ctx.storage.get('error-object');
      
      // Verify what gets preserved vs. what gets lost with Error objects in structured clone
      expect(retrievedError).toBeInstanceOf(Error);
      expect(retrievedError.message).toBe('Test error message'); // Message is preserved
      expect(retrievedError.name).toBe('Error'); // Name gets reset to 'Error'
      expect(retrievedError.stack).toBeDefined(); // Stack trace is preserved
      
      // Custom properties on Error objects are NOT preserved by structured clone
      expect((retrievedError as any).code).toBeUndefined();
      expect((retrievedError as any).metadata).toBeUndefined();
      
      // For better error handling, store error info as a regular object instead
      const errorInfo = {
        message: customError.message,
        name: customError.name,
        code: (customError as any).code,
        metadata: (customError as any).metadata,
        stack: customError.stack
      };
      
      await instance.ctx.storage.put('error-info', errorInfo);
      const retrievedErrorInfo = await instance.ctx.storage.get('error-info');
      
      // Regular objects preserve all properties perfectly
      expect(retrievedErrorInfo.message).toBe('Test error message');
      expect(retrievedErrorInfo.name).toBe('CustomTestError');
      expect(retrievedErrorInfo.code).toBe('TEST_ERROR_CODE');
      expect(retrievedErrorInfo.metadata.source).toBe('test-suite');
      expect(retrievedErrorInfo.metadata.timestamp).toBeInstanceOf(Date);

    });
  });

  it('provides function discovery through property access preprocessing', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'function-discovery-test');
      
      // Function and static property discovery is available via __asObject()
      // This shows the complete API surface including methods from the prototype chain
      const storageAsProperty = await instance.ctx.storage.__asObject();
      
      // Test that we get a comprehensive function map showing all available methods
      // INCLUDING nested objects like kv and sql with their methods inline!
      expect(storageAsProperty).toMatchObject({
        // Top-level storage methods
        get: "get [Function]",
        put: "put [Function]",
        delete: "delete [Function]",
        list: "list [Function]",
        deleteAll: "deleteAll [Function]",
        transaction: "transaction [Function]",
        getAlarm: "getAlarm [Function]",
        setAlarm: "setAlarm [Function]",
        deleteAlarm: "deleteAlarm [Function]",
        sync: "sync [Function]",
        transactionSync: "transactionSync [Function]",
        getCurrentBookmark: "getCurrentBookmark [Function]",
        getBookmarkForTime: "getBookmarkForTime [Function]",
        onNextSessionRestoreBookmark: "onNextSessionRestoreBookmark [Function]",
        
        // Nested kv object with its methods inline - accessible via __asObject()!
        kv: {
          get: "get [Function]",
          put: "put [Function]",
          list: "list [Function]",
          delete: "delete [Function]"
        },
        
        // Nested sql object with its methods and properties inline  
        sql: {
          exec: "exec [Function]",
          Cursor: "Cursor [Function]",
          Statement: "Statement [Function]",
          databaseSize: expect.any(Number) // Non-function properties preserved
        }
      });
    });
  });

  it('demonstrates how errors are serialized across the tunnel and re-thrown', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      const instance = instances('MY_DO', 'natural-syntax-test');
      const storageAsProperty = await instance.ctx.storage.__asObject();
      expect(storageAsProperty).toBeDefined();
      
      // Test getting the value of a non-existent property (returns undefined, doesn't throw)
      const nonExistentProperty = storageAsProperty.nonExistentProperty;
      expect(nonExistentProperty).toBeUndefined();
      
      // Test calling that property as a function (should throw with meaningful error message)
      await expect(async () => {
        await nonExistentProperty();
      }).rejects.toThrow("nonExistentProperty is not a function");
      
      // Test calling a non-existent method on instance (should throw with meaningful error message)
      await expect(async () => {
        await instance.nonExistentMethod();
      }).rejects.toThrow("Method 'nonExistentMethod' does not exist on MyDO");      
    });
  });

describe('Cookie Management Comprehensive Tests', () => {

  it('demonstrates hostname inference behavior (first fetch sets if not manual, last manual wins)', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // No hostname set initially
      expect(helpers.options.hostname).toBeUndefined();
      
      // First fetch to example.com sets hostname automatically  
      await SELF.fetch('https://example.com/login?user=test');
      expect(helpers.options.hostname).toBe('example.com');
      
      // Second fetch to different domain doesn't change hostname (already set)
      await SELF.fetch('https://other.com/login?user=test');
      expect(helpers.options.hostname).toBe('example.com'); // Still example.com
      
      // Manual change works (last manual setting wins)
      helpers.options.hostname = 'other.com';
      expect(helpers.options.hostname).toBe('other.com');
    });
  });

  it('demonstrates manual hostname setting prevents fetch override (last manual wins)', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Manually set hostname first
      helpers.options.hostname = 'manual.com';
      expect(helpers.options.hostname).toBe('manual.com');
      
      // Fetch to different domain doesn't override manual setting
      await SELF.fetch('https://example.com/login?user=test');
      expect(helpers.options.hostname).toBe('manual.com'); // Still manual.com
      
      // Another fetch also doesn't override
      await SELF.fetch('https://other.com/login?user=test');
      expect(helpers.options.hostname).toBe('manual.com'); // Still manual.com
      
      // But another manual setting does override (last manual wins)
      helpers.options.hostname = 'new-manual.com';
      expect(helpers.options.hostname).toBe('new-manual.com');
    });
  });

  it('can disable and re-enable cookie jar via options', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Disable cookie jar
      helpers.options.cookieJar = false;
      
      // Login attempt won't store cookies
      await SELF.fetch('https://example.com/login?user=test');
      expect(helpers.cookies.get('token')).toBeUndefined();
      
      // Re-enable and try again
      helpers.options.cookieJar = true;
      helpers.options.hostname = 'example.com';
      
      await SELF.fetch('https://example.com/login?user=test');
      expect(helpers.cookies.get('token')).toBe('abc123');
    });
  });

  it('validates cookie domain matching and path handling', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      helpers.options.hostname = 'example.com';
      
      // Set cookies with different paths
      helpers.cookies.set('root-cookie', 'root-value', { path: '/' });
      helpers.cookies.set('api-cookie', 'api-value', { path: '/api' });
      
      // Root path gets both cookies
      const rootCookies = helpers.cookies.getAll();
      expect(rootCookies.map((c: any) => c.name)).toContain('root-cookie');
      expect(rootCookies.map((c: any) => c.name)).toContain('api-cookie');
      
      // Test expiration handling
      const pastDate = new Date('2020-01-01');
      helpers.cookies.set('expired-cookie', 'expired-value', { expires: pastDate });
      
      // Expired cookie should not be retrieved
      expect(helpers.cookies.get('expired-cookie')).toBeUndefined();
    });
  });

  it('handles complex multi-domain cookie scenarios', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      // Set up cookies for different domains
      helpers.cookies.set('example-cookie', 'example-value', { domain: 'example.com' });
      helpers.cookies.set('test-cookie', 'test-value', { domain: 'test.com' });
      
      // Verify domain isolation
      expect(helpers.cookies.get('example-cookie', 'example.com')).toBe('example-value');
      expect(helpers.cookies.get('example-cookie', 'test.com')).toBeUndefined();
      expect(helpers.cookies.get('test-cookie', 'test.com')).toBe('test-value');
      expect(helpers.cookies.get('test-cookie', 'example.com')).toBeUndefined();
      
      // Test cookie removal
      helpers.cookies.remove('example-cookie', 'example.com');
      expect(helpers.cookies.get('example-cookie', 'example.com')).toBeUndefined();
      expect(helpers.cookies.get('test-cookie', 'test.com')).toBe('test-value'); // Still there
      
      // Clear all cookies
      helpers.cookies.clear();
      expect(helpers.cookies.getAll()).toHaveLength(0);
    });
  });
  
});

describe('WebSocket comprehensive testing', () => {

  // Test client-initiated WebSocket close behavior
  it('handles client-initiated WebSocket closes with proper handshake', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      
      const ws = new helpers.WebSocket('wss://example.com/my-do/client-close-test');
      
      let clientCloseEventFired = false;
      let clientCloseEventCount = 0; // Track event count to ensure no duplicates
      let clientCloseCode: number | undefined;
      let clientCloseReason: string | undefined;
      let clientWasClean: boolean | undefined;
      let clientOpened = false;
      
      ws.onopen = () => {
        clientOpened = true;
        // Send a test message to ensure connection is working
        ws.send('Hello from client');
      };
      
      ws.onclose = (event: CloseEvent) => {
        clientCloseEventFired = true;
        clientCloseEventCount++; // Increment event count
        clientCloseCode = event.code;
        clientCloseReason = event.reason;
        clientWasClean = event.wasClean;
        
        // Client-initiated close: onclose fires after server responds with Close frame (full handshake)
        // At this point, the connection is fully closed, so readyState is CLOSED (3)
        expect(ws.readyState).toBe(3); // WebSocket.CLOSED - handshake complete
      };
      
      ws.onerror = (error: Event) => {
        // Error handler for debugging
      };
      
      // Wait for connection to be established
      await vi.waitFor(() => clientOpened, { timeout: 2000 });
      
      // Wait a bit more to ensure everything is fully set up
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Initiate client close with custom code and reason
      ws.close(1001, "Client going away");
      
      // Wait for close event to fire and verify
      await vi.waitFor(() => {
        return clientCloseEventFired;
      }, { timeout: 5000 });
      
      // Wait a bit more for server to process the close handshake completely
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // ASSERTIONS: Client-initiated close behavior
      expect(clientCloseEventFired).toBe(true);
      expect(clientCloseEventCount).toBe(1); // Ensure no duplicate events
      expect(clientCloseCode).toBe(1001);
      expect(clientCloseReason).toBe("Client going away");
      expect(clientWasClean).toBe(true); // Client-initiated closes are considered clean
      expect(ws.readyState).toBe(3); // WebSocket.CLOSED
      
      // Verify the close was recorded on the server side  
      // Server receives client's Close frame and triggers webSocketClose handler
      const clientCloseData = await instances('MY_DO', 'client-close-test').ctx.storage.get('lastWebSocketClose');
      expect(clientCloseData).toEqual({
        code: 1001,
        reason: "Client going away", 
        wasClean: true
      });
    });
  });

  // Test server-initiated WebSocket close behavior
  it('handles server-initiated WebSocket closes with proper protocol compliance', async () => {
    await testDOProject(async (SELF, instances, helpers) => {
      
      const ws = new helpers.WebSocket('wss://example.com/my-do/server-close-test');
      
      let serverCloseEventFired = false;
      let serverCloseEventCount = 0; // Track event count to ensure no duplicates
      let serverCloseCode: number | undefined;
      let serverCloseReason: string | undefined;
      let serverWasClean: boolean | undefined;
      
      ws.onopen = () => {
        // Send special message to trigger server-initiated close
        ws.send('test-server-close');
      };
      
      ws.onclose = (event: CloseEvent) => {
        serverCloseEventFired = true;
        serverCloseEventCount++; // Increment event count
        serverCloseCode = event.code;
        serverCloseReason = event.reason;
        serverWasClean = event.wasClean;
        
        // Server-initiated close: Client receives Close frame and fires onclose immediately
        // Connection is still CLOSING because client hasn't finished sending its response frame yet
        expect(ws.readyState).toBe(2); // WebSocket.CLOSING - response frame pending
      };
      
      // Wait for connection to be established and server to close it
      await vi.waitFor(() => expect(serverCloseEventFired).toBe(true), { timeout: 2000 });
      
      // ASSERTIONS: Server-initiated close behavior
      expect(serverCloseEventFired).toBe(true);
      expect(serverCloseEventCount).toBe(1); // Ensure no duplicate events
      expect(serverCloseCode).toBe(4001); // Custom code from server
      expect(serverCloseReason).toBe("Server initiated close for testing");
      expect(serverWasClean).toBe(true); // Server properly initiated close
      expect(ws.readyState).toBe(2); // WebSocket.CLOSING (not yet fully closed)
      
      // Server-initiated closes do NOT trigger the webSocketClose handler
      // When the server calls ws.close() itself, it does NOT invoke its own webSocketClose method
      // This is confirmed Cloudflare Workers behavior - webSocketClose only triggers for peer-initiated closes
      // The client does send a responding Close frame per RFC 6455, but Cloudflare Workers doesn't
      // trigger the handler for these "protocol compliance" response frames.
      const serverCloseData = await instances('MY_DO', 'server-close-test').ctx.storage.get('lastWebSocketClose');
      expect(serverCloseData).toBeUndefined(); // Server doesn't record its own initiated closes
    });
  });

});