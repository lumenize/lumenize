/**
 * The Node twin of Studio's `HostWait`: waiting for a host to answer before connecting to it. Pure,
 * so the Node lane tests it without the Worker graph `harness.ts` pulls in.
 */

/**
 * How long a page may take to arrive at an app's host it just made: long enough, on a deployed
 * target, to wait out the certificate {@link waitForHost} describes, and 30 s locally, where it
 * answers at once. For a `waitForURL` behind a count-up.
 */
export const NEW_HOST_TIMEOUT_MS = process.env.HARNESS_TARGET_URL !== undefined ? 360_000 : 30_000;

/**
 * Resolve once `url`'s host answers. On a deployed target a new app's host fails its TLS handshake
 * until the app's certificate pack is active, two and a half to four minutes after the app is
 * created, which `HostWait` waits out the same way in the browser; a local host answers the first
 * probe. Throws naming the host if it never answers.
 */
export async function waitForHost(
  url: string,
  opts: { probe?: (origin: string) => Promise<unknown>; intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const origin = new URL(url).origin;
  const probe = opts.probe ?? (async (o: string) => {
    const res = await fetch(`${o}/`, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel();
  });
  const deadline = Date.now() + (opts.timeoutMs ?? 360_000);
  for (;;) {
    try {
      await probe(origin);
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`${origin} never answered: ${(e as Error).message}`, { cause: e });
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2_000));
  }
}
