/**
 * Test harness for alarms e2e tests using @lumenize/testing
 *
 * This instruments the DOs to enable createTestingClient to access
 * storage and other internals for test assertions.
 */

import * as sourceModule from '../index.js';
import { instrumentDOProject } from '@lumenize/testing';

// Instrument the DOs
const instrumented = instrumentDOProject(sourceModule);

// Re-export instrumented DOs for wrangler bindings
export const { ReminderDO } = instrumented.dos;

// Re-export the instrumented default export (worker handler)
export default instrumented;
