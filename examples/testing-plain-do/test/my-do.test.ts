import { describe, it, expect, vi } from 'vitest';
import { MyDO } from './test-harness.js';
import { testDOProject } from '@lumenize/testing';

describe('MyDO', () => {

  it('should do something inside MyDO', async () => {
    await testDOProject(async (SELF, doInstances, helpers) => {
      const myDO1Ws = SELF.fetch('https://example.com/my-do/instance-name');


      helpers.flush();  // Not sure we'll need this but just trying to show what helpers is for
    }

  });

});