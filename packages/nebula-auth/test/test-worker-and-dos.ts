/**
 * Test worker that exports DO classes and email sender for wrangler bindings.
 * Uses the real Nebula Worker router.
 *
 * Phase 5: Real Worker router replacing 404 stub.
 */

// Re-export the real DO classes
export { NebulaAuth } from '../src/nebula-auth';
export { NebulaAuthRegistry } from '../src/nebula-auth-registry';

// Email sender service binding entrypoint
export { NebulaEmailSender } from '../src/nebula-email-sender';

// Use the real Worker router
export { default } from '../src/nebula-worker';
