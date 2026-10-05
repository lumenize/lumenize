/**
 * Test worker entry point — exports DO classes and default fetch handler
 * for wrangler bindings. Lives next to test/wrangler.jsonc.
 */
import { routeNebulaAuthRequest } from '../src/router';
import { NebulaEmailSender as ProdNebulaEmailSender } from '../src/nebula-email-sender';
import { debug } from '@lumenize/debug';
import { DurableObject } from 'cloudflare:workers';
import type { ResolvedEmail } from '@lumenize/email';
import type { EmailMessage, ScopeLifecycleHooks, ScopeTarget } from '../src/types';

import { NebulaAuthRegistry as NebulaAuthRegistryBase } from '../src/nebula-auth-registry';

/**
 * Runs after each refresh-KV delete the Registry makes, while the Registry still awaits it — where a
 * test plays a concurrent writer inside a revoke, the one interleaving no request can time. The test
 * and the Registry share one isolate.
 */
export const registryKvHook: { afterDelete?: (key: string) => Promise<void> } = {};

/** The singleton Registry, for wrangler bindings, with its refresh KV wrapped for
 *  {@link registryKvHook}; with no hook set, every call passes straight through. */
export class NebulaAuthRegistry extends NebulaAuthRegistryBase {
  constructor(ctx: DurableObjectState, env: Env) {
    const kv = (env as any).REFRESH_TOKEN_KV as KVNamespace;
    const wrapped = new Proxy(kv, {
      get(target, prop) {
        if (prop === 'delete') {
          return async (key: string) => { await target.delete(key); await registryKvHook.afterDelete?.(key); };
        }
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    super(ctx, { ...(env as any), REFRESH_TOKEN_KV: wrapped });
  }
}
// The consent route's display names live on the person's Profile (bound as PROFILE).
export { Profile } from '../src/profile';

/**
 * A behavior-less SQLite-backed DO used ONLY to obtain a virgin `ctx.storage` in migration tests.
 * The real `NebulaAuthRegistry` migrates eagerly in its constructor, so a registry stub's storage is
 * never pre-migration — the prod-path (seed-old-schema) test needs a DO that runs no migrations itself.
 */
export class BareStorageDO extends DurableObject {}

/**
 * Email sender service binding entrypoint (bound as AUTH_EMAIL_SENDER) — a TEST
 * subclass that captures-and-drops instead of hitting a real provider.
 *
 * Why: these unit tests exercise the auth flows, not delivery, and the symlinked
 * `.dev.vars` supplies `RESEND_API_KEY` with no `EMAIL` binding — so the
 * production `sendEmail` (via `@lumenize/email`'s `createEmailTransport`) would
 * make REAL Resend API calls that fail ("domain not verified", rate-limited) as
 * uncaught fire-and-forget rejections on the entrypoint side. Capturing here
 * keeps every send in-process and side-effect-free; the `nebula-auth.test.email`
 * debug marker lets a future test assert sends via a sink. (Real-delivery
 * coverage lives in `packages/auth/test/e2e-email*` and the nebula browser
 * harness, which use a verified domain + `remote: true`.)
 */
/**
 * Every message the capturing sender received, in dispatch order — the REAL-mail assertion surface
 * (vitest-plugin runs the worker and the test in ONE isolate, so the test imports and reads
 * this directly). Template-selection tests read `type` and the typed link fields off the message
 * itself rather than test-mode `links` — asserting via the `links` map is the recorded 2026-08-04
 * defect (the email path never exercised). Tests clear it between cases.
 */
export const capturedEmails: EmailMessage[] = [];

export class NebulaEmailSender extends ProdNebulaEmailSender {
  override async send(message: EmailMessage): Promise<void> {
    capturedEmails.push(message);
    await super.send(message);
  }

  override async sendEmail(email: ResolvedEmail): Promise<void> {
    debug('nebula-auth.test.email').debug('captured (test sender — no real send)', {
      to: email.to,
      subject: email.subject,
    });
  }
}

/**
 * Every teardown the router asked for, in order. This package names no Galaxy or Star, so the
 * hooks record rather than wipe; a test reads this directly (one isolate, as with
 * {@link capturedEmails}) and clears it between cases.
 */
export const recordedTeardowns: Array<{ targets: ScopeTarget[]; cause: string; operationId: string }> = [];

/** Every certificate wake the router asked for, in order, read and cleared like the teardowns. */
export const recordedOrders: Array<{ galaxy: string; operationId: string }> = [];

/** What a wake does besides recording, set by a test: a deletion landing in the gap, say. */
export const orderHook: { onOrder?: (galaxy: string) => Promise<void> } = {};

/** The `hooks` every router call under test passes. */
export const recordingHooks: ScopeLifecycleHooks = {
  async teardown(targets, cause, operationId) {
    recordedTeardowns.push({ targets, cause, operationId });
  },
  async orderCertificate(galaxy, operationId) {
    recordedOrders.push({ galaxy, operationId });
    await orderHook.onOrder?.(galaxy);
  },
};

// Default Worker export — test-only, not part of the library's public API
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await routeNebulaAuthRequest(request, env, { hooks: recordingHooks })
      ?? new Response('Not Found', { status: 404 });
  },
};
