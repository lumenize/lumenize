/**
 * CORS tests for routeNebulaAuthRequest.
 *
 * Covers the four cases from tasks/playwright-test-template.md § 3:
 * (a) no `Origin` header → no CORS headers in response
 * (b) `Origin` not in list → 403 reject, no CORS headers
 * (c) `Origin` in list → response wrapped with `Access-Control-Allow-Origin`
 * (d) preflight `OPTIONS` → 204 with correct headers (allowed) / 204 without (rejected)
 *
 * Tests call the router function directly (not via SELF) so we can vary the
 * cors config per case without rebuilding the test worker.
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { routeNebulaAuthRequest } from '../src/router';

const ALLOWED = 'https://app.example.com';
const OTHER_ALLOWED = 'https://admin.example.com';
const REJECTED = 'https://evil.example.com';

/**
 * Build a request to an instance path with no Authorization header.
 *
 * Routing reaches `checkJwtForInstance` and returns 401 deterministically
 * without touching either NA or Registry DO state — perfect for testing the
 * CORS-wrapping layer in isolation.
 */
function unauthRequest(method: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/auth/test/some-protected-endpoint', {
    method,
    headers,
  });
}

describe('routeNebulaAuthRequest CORS', () => {
  describe('no cors option (default)', () => {
    it('does not add CORS headers when no Origin header is present', async () => {
      const response = await routeNebulaAuthRequest(unauthRequest('POST'), env);
      expect(response).toBeDefined();
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
      expect(response!.headers.has('Vary')).toBe(false);
    });

    it('does not add CORS headers even when Origin is present (no cors config)', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('POST', { Origin: ALLOWED }),
        env,
      );
      expect(response).toBeDefined();
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
    });

    it('forwards request when no Origin header is present (same-origin pass-through)', async () => {
      // No CORS gating without cors config; reaches handler → 401 from checkJwtForInstance
      const response = await routeNebulaAuthRequest(unauthRequest('POST'), env);
      expect(response!.status).toBe(401);
    });
  });

  describe('allowlist mode (cors: { origin: [...] })', () => {
    const corsOpts = { cors: { origin: [ALLOWED, OTHER_ALLOWED] } };

    it('does not add CORS headers when no Origin header is present', async () => {
      // Same-origin / non-browser callers omit Origin; pass through with no CORS headers
      const response = await routeNebulaAuthRequest(unauthRequest('POST'), env, corsOpts);
      expect(response).toBeDefined();
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
      // Should still reach the handler (returns 401)
      expect(response!.status).toBe(401);
    });

    it('returns 403 without CORS headers when Origin is not in the list', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('POST', { Origin: REJECTED }),
        env,
        corsOpts,
      );
      expect(response).toBeDefined();
      expect(response!.status).toBe(403);
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
      // Should NOT have reached the handler — 403 is from CORS gate, not from 401 path
      const body = await response!.text();
      expect(body).toContain('Origin not allowed');
    });

    it('wraps response with Access-Control-Allow-Origin when Origin is in the list', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('POST', { Origin: ALLOWED }),
        env,
        corsOpts,
      );
      expect(response).toBeDefined();
      expect(response!.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
      expect(response!.headers.get('Vary')).toBe('Origin');
      // CORS layer is transparent — handler still runs and returns its 401
      expect(response!.status).toBe(401);
    });

    it('wraps response for second allowed origin', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('POST', { Origin: OTHER_ALLOWED }),
        env,
        corsOpts,
      );
      expect(response!.headers.get('Access-Control-Allow-Origin')).toBe(OTHER_ALLOWED);
    });

    it('handles OPTIONS preflight from allowed origin with 204 + CORS headers', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('OPTIONS', {
          Origin: ALLOWED,
          'Access-Control-Request-Method': 'POST',
        }),
        env,
        corsOpts,
      );
      expect(response).toBeDefined();
      expect(response!.status).toBe(204);
      expect(response!.headers.get('Access-Control-Allow-Origin')).toBe(ALLOWED);
      expect(response!.headers.get('Vary')).toBe('Origin');
    });

    it('handles OPTIONS preflight from rejected origin with 204 and NO CORS headers', async () => {
      // Per CORS spec: respond to OPTIONS even when origin is disallowed, but omit
      // the Access-Control-Allow-Origin header so the browser blocks the actual call.
      const response = await routeNebulaAuthRequest(
        unauthRequest('OPTIONS', {
          Origin: REJECTED,
          'Access-Control-Request-Method': 'POST',
        }),
        env,
        corsOpts,
      );
      expect(response).toBeDefined();
      expect(response!.status).toBe(204);
      expect(response!.headers.has('Access-Control-Allow-Origin')).toBe(false);
    });

    it('falls through to undefined for non-matching paths even with CORS configured', async () => {
      // Composability: a request that doesn't match the `/auth/` prefix must still
      // return `undefined` so the entrypoint can try the next router.
      const response = await routeNebulaAuthRequest(
        new Request('http://localhost/gateway/foo/bar', {
          method: 'POST',
          headers: { Origin: ALLOWED },
        }),
        env,
        corsOpts,
      );
      expect(response).toBeUndefined();
    });
  });

  describe('cors: true (permissive)', () => {
    it('reflects any Origin', async () => {
      const response = await routeNebulaAuthRequest(
        unauthRequest('POST', { Origin: 'https://random.example.com' }),
        env,
        { cors: true },
      );
      expect(response!.headers.get('Access-Control-Allow-Origin')).toBe('https://random.example.com');
    });
  });
});
