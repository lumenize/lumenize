import { describe, it, expect, vi } from 'vitest';
import { testDOProject } from '@lumenize/testing';
// @ts-expect-error - cloudflare:test module types are not consistently exported
import { env } from 'cloudflare:test';

describe('MyDO', () => {

  it('should do something inside MyDO', async () => {
    await testDOProject(async (SELF, durableObjects, helpers) => {
      // First test the original SELF.fetch call
      const myDO1Ws = SELF.fetch('https://example.com/my-do/instance-name');
      expect(myDO1Ws).toBeDefined();
      console.log('%o', { myDO1Ws });

      // Now test all Durable Object access patterns
      
      // Pattern 1: Using getByName (direct named access)
      const directStub = env.MY_DO.getByName('my-direct-instance');
      console.log('Got direct stub:', directStub);
      
      // Pattern 2: Using idFromName + get (two-step named access)
      const namedId = env.MY_DO.idFromName('my-instance-name');
      console.log('Created named ID:', namedId.toString());
      const namedStub = env.MY_DO.get(namedId);
      console.log('Got named stub:', namedStub);
      
      // Pattern 3: Using newUniqueId + get (anonymous instances)
      const uniqueId = env.MY_DO.newUniqueId();
      console.log('Created unique ID:', uniqueId.toString());
      const uniqueStub = env.MY_DO.get(uniqueId);
      console.log('Got unique stub:', uniqueStub);
      
      // Check if our durableObjects map was populated
      expect(durableObjects).toBeDefined();
      console.log('durableObjects map:');
      for (const [bindingName, instanceMap] of durableObjects) {
        console.log(`  ${bindingName}:`);
        for (const [instanceId, stub] of instanceMap) {
          console.log(`    ${instanceId}: ${stub}`);
        }
      }

      helpers.flush();
    }, {
      someOption: 'someValue',
    });

  });

});