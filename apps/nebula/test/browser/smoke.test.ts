/**
 * Smoke test — minimum probe that validates the browser harness pipeline:
 * globalSetup spawned wrangler dev (over HTTPS, no test mode), exposed the
 * URL via provide(), and a Browser instance can reach the live Worker.
 *
 * The boot check is a regression test for the
 * @lumenize/ts-runtime-parser-validator deps-bundle crash that previously
 * blocked any Worker importing @lumenize/nebula from booting under real
 * `wrangler dev`. If that bug ever returns, this test fails on its own,
 * separate from any auth/round-trip wiring failures.
 *
 * The full round-trip test (real magic-link email → cookie → ontology
 * register → callStarTransaction) lives in a separate it block — and a
 * separate file once it lands — so a regression in either doesn't mask
 * the other.
 */

import { describe, it, expect, inject } from 'vitest';
import { Browser } from '@lumenize/testing';

describe('browser harness', () => {
  it('Worker boots and serves a non-5xx response', async () => {
    const baseUrl = inject('wranglerBaseUrl');
    expect(baseUrl).toMatch(/^https:\/\//);

    // Browser auto-detects globalThis.fetch in Node, no SELF.fetch in Workers.
    const browser = new Browser();
    const response = await browser.fetch(baseUrl);

    // 4xx (e.g. 404 from the auth router on '/') is fine — proves the Worker
    // loaded and is dispatching requests. 5xx means module-load or runtime
    // failure, which is the regression we're catching here.
    expect(response.status).toBeLessThan(500);
  });
});
