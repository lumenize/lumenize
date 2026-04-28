/**
 * Smoke test — minimum probe that validates the browser harness pipeline:
 * globalSetup spawned wrangler dev, exposed the URL via provide(), and a
 * browser-side fetch reaches the live Worker.
 *
 * Once this passes, layer on auth bootstrap + NebulaClient transaction tests.
 */

import { describe, it, expect, inject } from 'vitest';

describe('browser harness', () => {
  it('reaches wrangler dev via provided base URL', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    expect(baseUrl).toMatch(/^http/);

    // Any response means wrangler dev is up. The baseline test-app's root
    // route may 404, which is fine — we only care that the network layer
    // works and Chromium can talk to the Worker.
    const res = await fetch(baseUrl);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });
});
