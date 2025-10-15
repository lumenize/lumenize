import * as sourceModule from '../src';
import { instrumentDOProject } from '@lumenize/testing';

// Specify which exports are Durable Objects
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['ChatAgent', 'AuthAgent']
});

export const { ChatAgent, AuthAgent } = instrumented.dos;
export default instrumented;
