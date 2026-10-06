/**
 * The entry rule and the walk rules run in a REAL BROWSER, on the client's own executor.
 *
 * **Why this limb exists when every other tier already covers the same rules.** Two things make it
 * the one nothing substitutes for:
 *
 * 1. **It proves the rules are COMPOSED, not seam-written.** Five runners execute a chain —
 *    `executeEnvelope`'s two doors, the two `__localChainExecutor` getters, and the browser client,
 *    which calls `executeOperationChain(chain, this)` with no config and therefore takes the secure
 *    default. A fix written at the envelope seam satisfies every OTHER criterion in
 *    `tasks/archive/mesh-entry-and-walk-gaps.md` while leaving this door wide open.
 * 2. **It is the only place `constructor` reaches `Function`.** workerd refuses that walk with an
 *    `EvalError`; unrestricted V8 does not. The probe table's V8 row can only be driven here.
 *
 * **No chain-forging DO is needed.** The Gateway relays whatever `(binding, instance)` a client's
 * own message names, so a client addressing the Gateway binding at its OWN instance name gets the
 * chain pushed back down to itself and run on its own executor — the same inbound door a genuine
 * DO push arrives at.
 *
 * Written RED-first: the client used to check only the first `apply`, so every walk limb below was
 * permitted — including the one that reaches `Function`, which only a browser can drive.
 */
import { describe, it, expect, inject, vi } from 'vitest';
import { EditorClient } from '../for-docs/getting-started/editor-client';
import { continuationFromChain } from '../continuation-from-chain';
import type { OperationChain } from '../../src/ocan/index';


describe('@lumenize/mesh entry + walk rules on the client executor (real chromium)', () => {
  it('refuses what a remote caller must not reach, in the browser', async () => {
    const proxyPath = inject('wranglerBaseUrl');
    const baseUrl = globalThis.location!.origin + proxyPath;

    // globalSetup's ONE real magic-link login — see auth-bootstrap.ts for why it is not per file.
    const accessToken = inject('adminAccessToken');
    const client = new EditorClient({
      baseUrl, accessToken, refresh: `${proxyPath}/auth/refresh-token`,
    });

    try {
      await vi.waitFor(() => {
        expect(client.connectionState).toBe('connected');
      }, { timeout: 10_000, interval: 100 });

      /**
       * Send `chain` to THIS client through the Gateway and report what its own executor did.
       *
       * ⚠️ **This route relays REFUSALS and nothing else** — `#handleClientCall` sends a
       * `response` back only when the ack carries `$error`, so a chain that RUNS answers
       * with silence. That makes silence a measurement rather than an absence, and the two
       * calibration limbs below are what turn it into one: they establish that a refusal really
       * does come back and that a successful chain really is silent, on this exact door.
       */
      const PERMITTED = 'PERMITTED (this route answers a successful chain with silence)';
      const onClient = async (chain: OperationChain): Promise<string> => {
        try {
          await client.lmz.callAsync(
            client.lmz.bindingName!, client.lmz.instanceName,
            continuationFromChain(chain),
            { timeoutMs: 4_000 },
          );
          return PERMITTED;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return /timed out/i.test(message) ? PERMITTED : `REFUSED: ${message}`;
        }
      };

      // ⚠️ **Every limb runs and the verdict comes at the end.** Asserting inline would stop at
      //    the first failure and hide whether the later ones are measuring anything at all —
      //    the multi-limb hazard `.claude/rules/live.md` names, and this file's first run is a
      //    measurement of which doors are open.
      const limbs: Array<{ name: string; want: RegExp | typeof PERMITTED; chain: OperationChain }> = [
        // CALIBRATION A — a refusal really does reach the caller. Also the entry rule's own limb:
        // a method without `@mesh()` is the one hole today already closes, so it is GREEN before and
        // after.
        { name: 'a method without @mesh() is refused (and a refusal comes back)', want: /is not mesh-callable/,
          chain: [{ type: 'get', key: 'openDocument' }, { type: 'apply', args: ['doc-x'] }] },
        // CALIBRATION B — a chain that RUNS is silent. GREEN before and after, and it is what stops
        // a rule that refuses everything from satisfying every limb below.
        { name: 'a @mesh() method stays reachable over this same door', want: PERMITTED,
          chain: [{ type: 'get', key: 'handleContentUpdate' }, { type: 'apply', args: ['doc-x', 'hello'] }] },
        { name: 'constructor at op 0, a position no entry rule covers on every leg', want: /'constructor'/,
          chain: [{ type: 'get', key: 'constructor' }, { type: 'get', key: 'name' }] },
        { name: 'a Function.prototype member reached from a @mesh() method', want: /Function\.prototype/,
          chain: [{ type: 'get', key: 'handleContentUpdate' },
                  { type: 'get', key: 'bind' }, { type: 'get', key: 'name' }] },
        // The row only this venue can drive: workerd throws EvalError on `Function`, so a
        // server-side limb would pass for the wrong reason. Unrestricted V8 hands it over.
        { name: 'constructor.constructor reaches Function in a browser', want: /'constructor'/,
          chain: [{ type: 'get', key: 'constructor' }, { type: 'get', key: 'constructor' },
                  { type: 'get', key: 'name' }] },
      ];

      const failures: string[] = [];
      for (const limb of limbs) {
        const outcome = await onClient(limb.chain);
        const ok = limb.want === PERMITTED ? outcome === PERMITTED : (limb.want as RegExp).test(outcome);
        console.log(`${ok ? '\u2705' : '\u274c'} ${limb.name} \u2014 ${outcome}`);
        if (!ok) failures.push(`${limb.name}: ${outcome}`);
      }
      expect(failures, `${failures.length} of ${limbs.length} client-executor limbs do not hold`).toEqual([]);
    } finally {
      client[Symbol.dispose]();
    }
  }, 60_000);
});
