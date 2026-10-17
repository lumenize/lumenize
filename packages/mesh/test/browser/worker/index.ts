/**
 * Browser-test worker for @lumenize/mesh — the getting-started worker as it is, re-exported, plus a
 * real email sender, so its one login goes through real mail (ADR-009 rung 1).
 *
 * Everything else — Mesh's auth routes, each Client's upgrade on a scope's host through
 * `hostedUpgrade`, the `WorkspaceDO` host node and the `DocumentDO` + `SpellCheckWorker` mesh nodes —
 * comes from `test/for-docs/getting-started/`. That keeps the browser test pinned to the canonical
 * pattern: if a change to the getting-started example breaks the worker setup, this test fails loudly.
 */

export * from '../../for-docs/getting-started/index.js';
export { default } from '../../for-docs/getting-started/index.js';

/** Mail from `noreply@lumenize.io`, a verified sender; `EMAIL_PROVIDER` picks Resend. */
export { AuthEmailSender } from '../../../src/auth/auth-email-sender.js';
