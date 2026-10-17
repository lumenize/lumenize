import { spawnSync } from 'node:child_process';

/**
 * Stop the containers a killed `wrangler dev` leaves running. `pkill -9` takes workerd down before
 * it can stop its containers, so every container scenario a sweep kills leaves a
 * `cloudflare/proxy-everything` sidecar up, and a pile of them hangs `apps/nebula`'s vitest run
 * after its last test. Only containers a Nebula `wrangler dev` named (`workerd-nebula-…`) are
 * touched; with no Docker running there are none. Returns how many it stopped.
 */
export function stopOrphanedContainers(): number {
  const listed = spawnSync('docker', ['ps', '-q', '--filter', 'name=workerd-nebula-'], { encoding: 'utf8' });
  const ids = (listed.stdout ?? '').split('\n').filter(Boolean);
  if (ids.length > 0) spawnSync('docker', ['stop', ...ids], { stdio: 'ignore' });
  return ids.length;
}
