import * as sourceModule from '../src';
import { instrumentDOProject } from '@lumenize/testing';

// Simple case: Auto-detects MyDO since it's the only class export from '../src'
const instrumented = instrumentDOProject(sourceModule);

export const { MyDO } = instrumented.dos;
export default instrumented;

// If you had multiple DO classes in '../src', you'd get a helpful error like:
//
// Error: Found multiple class exports: MyDO, AnotherDO, HelperClass
//
// Please specify which are Durable Objects by using explicit configuration:
//
// const instrumented = instrumentDOProject({
//   sourceModule,
//   doClassNames: ['MyDO', 'AnotherDO']  // <-- Keep only the DO classes
// });
//
// export const { MyDO, AnotherDO } = instrumented.dos;
// export default instrumented;

