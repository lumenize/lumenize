import * as sourceModule from '../src';
import { instrumentDOProject } from '@lumenize/testing';

// Auto-detects all DurableObject subclasses via prototype chain
// walking — no need to list doClassNames, even with multiple DOs.
// WorkerEntrypoints and other non-DO classes are passed through
// unwrapped on the result object.
const instrumented = instrumentDOProject(sourceModule);

// Wrangler requires DO classes as named exports.
// For multiple DOs: export const { MyDO, AnotherDO } = instrumented.dos;
export const { MyDO } = instrumented.dos;
export default instrumented;
