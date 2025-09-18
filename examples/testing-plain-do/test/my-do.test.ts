import { describe, it, expect, vi } from 'vitest';
import { testDOProject } from '@lumenize/testing';

describe('MyDO', () => {

  it('should do something inside MyDO', async () => {
    await testDOProject(async (SELF, durableObjects, helpers) => {
      const myDO1Ws = SELF.fetch('https://example.com/my-do/instance-name');
      expect(myDO1Ws).toBeDefined();
      console.log('%o', { myDO1Ws });

      expect(durableObjects).toBeDefined();
      console.log('%o', { durableObjects });
      expect(durableObjects.get('MY_DO')?.get('my-instance-name')?.ctx.storage.kv.get('key')).toBe('value');

      helpers.flush();  // Not sure we'll need this but just trying to show what helpers is for
    }, {
      someOption: 'someValue',
    });

  });

});