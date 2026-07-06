/**
 * PROD drive entry — autonomous, NO local boot. Points at `nebula.lumenize.com`, uses the Turnstile
 * bypass token for a one-time login (then a stored refresh token), and runs a read-mostly command.
 *
 *   npx tsx apps/nebula/harness/prod.ts enumerate    # list the prod Universes (my-scopes, * token)
 *
 * Needs `.dev.vars` with NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN + TEST_TOKEN. No Docker, no wrangler dev.
 * @see tasks/archive/claude-live-verification.md — Phase 3b/3d
 */
import { PROD_URL, PLATFORM_SCOPE, prodAccessToken, prodEnumerate } from './lib/prod-drive';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'enumerate';
  console.error(`[prod] target=${PROD_URL} command=${cmd}`);
  if (cmd !== 'enumerate') {
    console.error(`[prod] unknown command "${cmd}". Known: enumerate`);
    process.exitCode = 2;
    return;
  }
  const token = await prodAccessToken(PLATFORM_SCOPE); // a `*` super-admin token
  const scopes = await prodEnumerate(token);
  console.log(JSON.stringify(scopes, null, 2));
  console.error('[prod] ✅ enumerated the prod scope tree');
}

main().catch((err) => {
  console.error('[prod] fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
