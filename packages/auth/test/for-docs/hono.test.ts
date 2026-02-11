/**
 * Documentation validation test for Hono integration examples
 *
 * The documented code appears below - the @check-example plugin validates it exists here.
 * The actual integration e2e test is in test/hono/hono-integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { LumenizeAuth, createAuthRoutes, honoAuthMiddleware } from '@lumenize/auth';

export { LumenizeAuth };

// --- Auth routes (docs: "Auth Endpoints") ---

const app = new Hono<{ Bindings: Env }>();

app.all('/auth/*', async (c) => {
  const authRoutes = createAuthRoutes(c.env);
  return (await authRoutes(c.req.raw)) ?? c.text('Not Found', 404);
});

// --- Protected routes (docs: "Protected Routes") ---

app.all('/api/:id/*?', honoAuthMiddleware((c) => ({
  doNamespace: (c.env as any).MY_DO,
  doInstanceNameOrId: c.req.param('id'),
})));

// --- Complete Worker entry point (docs: "Complete Example") ---

app.all('*', (c) => c.text('Not Found', 404));

export default app;

describe('Hono Integration Example', () => {
  it('validates the documented patterns compile correctly', () => {
    expect(typeof createAuthRoutes).toBe('function');
    expect(typeof honoAuthMiddleware).toBe('function');
    expect(typeof Hono).toBe('function');
  });
});
