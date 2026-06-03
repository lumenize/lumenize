/**
 * End-to-end mesh smoke test, real chromium edition.
 *
 * Mirrors `website/docs/mesh/getting-started.mdx` as closely as possible —
 * the worker is the documented worker (`createAuthRoutes` +
 * `createRouteDORequestAuthHooks` + `routeDORequest`), the client is the
 * documented `EditorClient`, and auth goes through a real magic-link email
 * (Cloudflare Email Sending → Email Routing → deployed `email-test`
 * worker). The only deviations from production are:
 *  - `AuthEmailSender.from` is `auth@nebula.lumenize.com` (a verified
 *    sending domain on this account) instead of `auth@example.com`.
 *  - No Turnstile gating (Turnstile is documented as optional, Step 9).
 *
 * Why this exists: the `@lumenize/debug` regression slipped past
 * vitest-pool-workers because both pool-workers and `tsx` resolve dynamic
 * imports at runtime. This test runs the actual end-user flow — Vite
 * bundles the client into a real browser, the browser drives a real
 * WebSocket through a real `wrangler dev`, and a real DO@`@mesh()` call
 * comes back. Any future change that breaks bundling, breaks
 * `LumenizeClient`'s browser runtime, breaks the mesh wire protocol, or
 * breaks the auth integration fails here loudly.
 */
import { describe, it, expect, inject, vi } from 'vitest';
import { EditorClient } from '../for-docs/getting-started/editor-client';
import type { SpellFinding } from '../for-docs/getting-started/spell-check-worker';
import { bootstrapAndGetAccessToken } from './auth-bootstrap';

const ADMIN_EMAIL = 'test@lumenize.io';

describe('@lumenize/mesh getting-started e2e (real chromium)', () => {
  it('drives full subscribe → save → broadcast + spell-check round-trip', async () => {
    // `wranglerBaseUrl` is the proxy path `/worker` (see global-setup.ts);
    // resolve it against the test page's origin so LumenizeClient gets a
    // full URL it can convert to `wss://`. Vite's dev server forwards
    // `/worker/*` to wrangler-dev, keeping everything same-origin from
    // chromium's POV (so `SameSite=Strict` cookies flow normally).
    const proxyPath = inject('wranglerBaseUrl');
    const testToken = inject('emailTestToken');
    const baseUrl = globalThis.location!.origin + proxyPath;

    // 1. Real magic-link login → JWT (mirrors the documented onboarding path)
    const accessToken = await bootstrapAndGetAccessToken({
      baseUrl,
      email: ADMIN_EMAIL,
      testToken,
    });
    expect(accessToken.split('.')).toHaveLength(3);

    // 2. Construct the documented EditorClient. LumenizeClient auto-derives
    //    instanceName from the JWT's `sub` claim + a sessionStorage-backed
    //    tabId, so we only have to pass the token.
    const client = new EditorClient({
      baseUrl,
      accessToken,
      refresh: `${proxyPath}/auth/refresh-token`,
    });

    try {
      // 3. Wait for connection
      await vi.waitFor(() => {
        expect(client.connectionState).toBe('connected');
      }, { timeout: 10_000, interval: 100 });

      // 4. Open a document with capture callbacks for both update + spell paths
      const documentId = `doc-${crypto.randomUUID().slice(0, 8)}`;
      const updates: string[] = [];
      const findings: SpellFinding[][] = [];
      const handle = client.openDocument(documentId, {
        onContentUpdate: (content) => updates.push(content),
        onSpellFindings: (f) => findings.push(f),
      });

      // 5. Wait for subscribe's initial-content callback (empty string on
      //    first subscribe — DocumentDO returns whatever's in storage)
      await vi.waitFor(() => {
        expect(updates.length).toBeGreaterThanOrEqual(1);
      }, { timeout: 5_000, interval: 50 });
      expect(updates[0]).toBe('');

      // 6. Save content with a misspelling — DocumentDO.update broadcasts
      //    back to subscribers AND fires SpellCheckWorker.check(), which
      //    sends findings DIRECTLY to this client (the "direct delivery"
      //    pattern from getting-started.mdx)
      handle.saveContent('teh quick brown fox');

      // 7. Both callbacks should fire: the broadcast on DocumentDO and the
      //    spell findings from SpellCheckWorker
      await vi.waitFor(() => {
        expect(updates).toContain('teh quick brown fox');
        expect(findings.length).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });

      // 8. Spell check should have flagged "teh" and suggested "the"
      const flat = findings.flat();
      const tehFinding = flat.find((f) => f.word.toLowerCase() === 'teh');
      expect(tehFinding, 'expected SpellCheckWorker to flag "teh"').toBeDefined();
      expect(tehFinding!.suggestions).toContain('the');
    } finally {
      (client as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    }
  }, 60_000);
});
