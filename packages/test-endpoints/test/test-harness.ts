import * as sourceModule from '../src';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument the project for testing
// Need explicit config since src/index exports functions too
const instrumented = instrumentDOProject({
  sourceModule,
  doClassNames: ['TestEndpointsDO']  // Only TestEndpointsDO is a DO class
});

export const { TestEndpointsDO } = instrumented.dos;
export default instrumented.worker;

