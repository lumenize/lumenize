/**
 * PROD drive entry — autonomous, NO local boot. Points at `nebula.lumenize.com`, uses the Turnstile
 * bypass token for a one-time login (then a stored refresh token), and runs a read-mostly command.
 *
 *   npx tsx apps/nebula/harness/prod.ts enumerate    # list the prod Universes (scope-summary, * token)
 *
 * Needs `.dev.vars` with NEBULA_AUTH_TURNSTILE_BYPASS_TOKEN + TEST_TOKEN. No Docker, no wrangler dev.
 * @see tasks/archive/claude-live-verification.md — Phase 3b/3d
 */
import { PROD_URL, PLATFORM_SCOPE, prodAccessToken, prodEnumerate, prodEmailSpin } from './lib/prod-drive';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'enumerate';
  console.error(`[prod] target=${PROD_URL} command=${cmd}`);
  if (cmd === 'spin') {
    // Catch-all health check: a FRESH, unruled @lumenize.io address must reach the email-test Worker.
    const email = `spin-${crypto.randomUUID().slice(0, 8)}@lumenize.io`;
    console.error(`[prod] requesting a magic link for a fresh unruled address: ${email}`);
    const link = await prodEmailSpin(email);
    console.error(`[prod] ✅ catch-all works — email-test Worker received the magic link for ${email}`);
    console.error(`[prod] (link received, NOT consumed → no subject created): ${link.slice(0, 60)}…`);
    return;
  }
  if (cmd !== 'enumerate') {
    console.error(`[prod] unknown command "${cmd}". Known: enumerate, spin`);
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
