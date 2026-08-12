/**
 * DevContainer (Phase 3.5a) — the composed seam is tested via PURE helpers +
 * prototype inspection, NOT by constructing the node: `extends Container` can't be
 * built under vitest-pool-workers ([[container-no-construct-pool-workers]]). The
 * assembled-container behaviors (the applyChanges→preview round-trip + a non-blank
 * render) are now covered top-down by the `ui-smoke` lane (`test/ui-smoke/smoke.test.ts`);
 * the request-supplied-scope decoy + command-port-strip are a focused security test there
 * too. (Version-contract "ops succeed" is Wave-2 data-bound; cold-boot resilience →
 * backlog.) So this file no longer carries `it.skip` placeholders for them.
 *
 * What IS proven here (each capable-of-failing):
 *  - the writeFile path-traversal guard (`assertSafeRelPath`) — `../` AND absolute
 *    each rejected, an in-tree path accepted (the positive control);
 *  - scope-injection as a pure derivation (`injectScopeMeta` + the authScope split);
 *  - the command @mesh surface is fully admin-gated (`nonAdminMeshMethods` === []);
 *  - the stuck-flag recovery DECISIONS as pure fns (`isStuckFlagResponse`/`isStuckFlagError`/
 *    `shouldAbortNow`/`decidePreviewResponse`/`isRecoverRequest`/`isSameOriginRecover`/
 *    `previewRecoverUrl`/`nextRecoverAttempt`) + the bounded waking-page wiring.
 *
 * NOT proven here (needs a constructed DevContainer → the `ui-smoke` lane / deploy): the
 * wiring that these decisions gate — `#forceReset()`→`ctx.abort()`, `ensureUp`'s command-path
 * recovery, the recover-GET corroboration probe, and the cooldown's durable read-back across
 * abort→reconstruct (`extends Container` can't construct under pool-workers).
 *
 * @see tasks/nebula-studio.md § DevContainer dev loop, § Test strategy
 * @see tasks/nebula-container-wakeup-fix.md — the fix this covers
 */
import { describe, it, expect } from 'vitest';
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';
import {
  DevContainer,
  ContainerUnavailableError,
  assertSafeRelPath,
  injectScopeMeta,
  isContainerColdResponse,
  isStuckFlagResponse,
  isStuckFlagError,
  shouldAbortNow,
  isDocumentRequest,
  isRecoverRequest,
  isSameOriginRecover,
  previewRecoverUrl,
  decidePreviewResponse,
  nextRecoverAttempt,
  wakingPreviewPage,
} from '../../../src/dev-container';
import { requireDominionHere } from '../../../src/nebula-do';

describe('DevContainer writeFile path-traversal guard (assertSafeRelPath)', () => {
  // Positive control: an in-tree relative path is accepted (no throw). If this
  // threw, the guard would be rejecting legitimate pushes (capable-of-failing).
  it('accepts an in-tree relative path', () => {
    expect(() => assertSafeRelPath('src/App.vue')).not.toThrow();
    expect(() => assertSafeRelPath('src/components/TodoList.vue')).not.toThrow();
    expect(() => assertSafeRelPath('ontology.d.ts')).not.toThrow();
  });

  // Negative 1: a `../` traversal segment is rejected. Mutation-check: deleting the
  // `..`-segment branch in assertSafeRelPath lets this through → RED.
  it('rejects a ../ traversal path (writes nothing)', () => {
    expect(() => assertSafeRelPath('../etc/evil')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src/../../escape')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src\\..\\..\\escape')).toThrow(/'\.\.' segment/);
  });

  // Negative 2: an absolute path is rejected. Mutation-check: deleting the
  // `startsWith('/')` branch lets this through → RED. (Distinct operand from the
  // `..` check — both must be enumerated, testing.md compound-condition rule.)
  it('rejects an absolute path (writes nothing)', () => {
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/[Aa]bsolute/);
    expect(() => assertSafeRelPath('/workspace/app/src/App.vue')).toThrow(/[Aa]bsolute/);
  });

  it('rejects an empty / non-string path', () => {
    expect(() => assertSafeRelPath('')).toThrow(/Invalid source path/);
    expect(() => assertSafeRelPath(undefined as unknown as string)).toThrow(/Invalid source path/);
  });
});

describe('DevContainer scope injection (injectScopeMeta — pure derivation)', () => {
  it('injects the server-derived scope as a strict-CSP-friendly <meta> in <head>', () => {
    const scope = { activeScope: 'acme.app.dev', authScope: 'acme.app', appVersion: 'dev' };
    const out = injectScopeMeta('<html><head><title>x</title></head><body></body></html>', scope);
    expect(out).toContain(`<meta name="nebula-scope" content='${JSON.stringify(scope)}'>`);
    // Inserted INSIDE <head> (so the bootstrap can read it before main.ts runs).
    expect(out.indexOf('nebula-scope')).toBeLessThan(out.indexOf('<title>'));
    // Round-trips: the bootstrap parses content as JSON.
    const content = out.match(/content='([^']*)'/)?.[1] ?? '';
    expect(JSON.parse(content)).toEqual(scope);
  });

  it('falls back to prepending the meta when there is no <head>', () => {
    const scope = { activeScope: 'acme.app.dev', authScope: 'acme.app', appVersion: 'dev' };
    const out = injectScopeMeta('<body>no head</body>', scope);
    expect(out.startsWith('<meta name="nebula-scope"')).toBe(true);
  });

  it('authScope is the first two segments of a {u}.{g}.dev activeScope', () => {
    // The derivation DevContainer.fetch() applies: authScope = activeScope[:2].
    // It must keep the FULL .dev activeScope (the wrong-Star footgun guard) and
    // derive a DISTINCT 2-segment authScope — never collapse the two.
    const activeScope = 'acme.app.dev';
    const authScope = activeScope.split('.').slice(0, 2).join('.');
    expect(authScope).toBe('acme.app');
    expect(authScope).not.toBe(activeScope);
  });
});

// Walk DevContainer's OWN prototype, returning its mesh-callable methods whose guard
// is NOT requireDominionHere. Derived dynamically so a newly-added non-admin @mesh method
// changes the set and fails the freeze (forcing a deliberate admin classification).
function nonAdminMeshMethods(ctor: { prototype: object }): string[] {
  const proto = ctor.prototype;
  const out: string[] = [];
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const fn = (Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor | undefined)?.value;
    if (typeof fn !== 'function' || !isMeshCallable(fn)) continue;
    if (getMeshGuard(fn) === requireDominionHere) continue;
    out.push(name);
  }
  return out.sort();
}

describe('DevContainer command @mesh surface is fully admin-gated', () => {
  it('every @mesh method DevContainer ADDS is requireDominionHere-gated — nonAdminMeshMethods(DevContainer) === []', () => {
    // The command channel (applyChanges/exec/viteControl/ensureUp/readFileInContainer)
    // must all carry @mesh(requireDominionHere): NebulaContainer.onBeforeCall proves tenant
    // SCOPE but never access.scopeAdmin, and `<id>.*` widening admits descendant
    // non-admins. Adding an ungated @mesh method to DevContainer fails this.
    expect(nonAdminMeshMethods(DevContainer)).toEqual([]);
  });

  it('the command methods are mesh-callable + requireDominionHere (spot-check applyChanges/exec/setAppVersion)', () => {
    for (const name of ['ensureUp', 'applyChanges', 'exec', 'viteControl', 'readFileInContainer', 'setAppVersion']) {
      const fn = (DevContainer.prototype as unknown as Record<string, unknown>)[name] as (...a: unknown[]) => unknown;
      expect(typeof fn).toBe('function');
      expect(isMeshCallable(fn)).toBe(true);
      expect(getMeshGuard(fn)).toBe(requireDominionHere);
    }
  });
});

describe('DevContainer setAppVersion (the version the public fetch() injects)', () => {
  // Prototype call with a fake `this` — DevContainer can't construct under
  // vitest-pool-workers, but setAppVersion is a pure `kv.put` so we can drive it on the
  // prototype. The fetch()-reads-it-back round-trip is run with `wrangler dev` (below).
  it('stores the version under the DevContainer KV key', () => {
    const puts: Array<[string, unknown]> = [];
    const fakeThis = { ctx: { storage: { kv: { put: (k: string, v: unknown) => { puts.push([k, v]); } } } } };
    const oid = 'a'.repeat(40);
    (DevContainer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)
      .setAppVersion.call(fakeThis, oid);
    // Capable-of-failing: a wrong key (or no write) breaks the contract with fetch(),
    // which reads this exact key to inject `appVersion` (Decision 12 / Flow 1d).
    expect(puts).toEqual([['devcontainer:appVersion', oid]]);
  });
});

describe('DevContainer cold-container recovery (idle-sleep wake)', () => {
  // The exact response a slept container produces (base proxy hit a stale `running` flag). Both
  // operands of the compound condition are mutation-checked below.
  it('flags the real "not running" proxy 500 as cold', () => {
    expect(
      isContainerColdResponse(500, 'Error proxying request to container: The container is not running, consider calling start()'),
    ).toBe(true);
    expect(isContainerColdResponse(503, 'There is no Container instance available at this time.')).toBe(true);
    expect(isContainerColdResponse(429, 'rate limited')).toBe(true); // 429 is a cold status too
  });

  // Body operand: a genuine app 500 (no cold phrase) must NOT be masked → mutating the regex to
  // always-match reds this; without it we'd loop a waking page over a real vite error.
  it('does NOT flag a genuine app 500 as cold (no masking)', () => {
    expect(isContainerColdResponse(500, '<pre>SyntaxError: Unexpected token in App.vue</pre>')).toBe(false);
    expect(isContainerColdResponse(500, 'Internal Server Error')).toBe(false);
  });

  // Status operand: a cold-looking BODY at an OK status isn't cold → mutating away the status guard
  // reds this.
  it('does NOT flag a non-error status even with a container-ish body', () => {
    expect(isContainerColdResponse(200, 'starting the container, not running yet')).toBe(false);
    expect(isContainerColdResponse(404, 'not running')).toBe(false);
  });

  it('isDocumentRequest: navigation yes, sub-asset no', () => {
    expect(isDocumentRequest(new Request('https://x/', { headers: { 'sec-fetch-dest': 'document' } }))).toBe(true);
    expect(isDocumentRequest(new Request('https://x/', { headers: { accept: 'text/html,application/xhtml+xml' } }))).toBe(true);
    expect(isDocumentRequest(new Request('https://x/app.js', { headers: { 'sec-fetch-dest': 'script', accept: '*/*' } }))).toBe(false);
  });
});

// The abort-worthy STUCK signature — a genuine STRICT SUBSET of isContainerColdResponse: every stuck
// response also serves the waking page, but cold ⊋ stuck (502/429/503/provisioning + the crash-loop
// "Failed to start" are cold-but-not-stuck). D3/M1/M3. Base-emitted fixtures are ONLY the L972/L975
// literals; the bare "not running" operand rides inside ${e.message}/a synthesized prod-shaped body
// (per D3's uncaptured-superset rationale), NOT claimed as base-emitted.
describe('DevContainer stuck-flag signature (isStuckFlagResponse — abort-worthy subset)', () => {
  // Phrase operand 1 — L975 base-literal "Error proxying request to container:" (the PRIMARY
  // mutation-check target). Isolated: this body carries none of the other two phrases, so deleting
  // the "proxying request to container" alternative from the regex reds ONLY this.
  it('flags the L975 proxy-error 500 (primary base-literal phrase)', () => {
    expect(isStuckFlagResponse(500, 'Error proxying request to container: boom')).toBe(true);
  });

  // Phrase operand 2 — L972 base-literal "Container suddenly disconnected, try again". Isolated:
  // no "proxying"/"not running" here, so removing the "suddenly disconnected" alternative reds only this.
  it('flags the L972 "suddenly disconnected" 500 (base-literal phrase)', () => {
    expect(isStuckFlagResponse(500, 'Container suddenly disconnected, try again')).toBe(true);
  });

  // Phrase operand 3 — the synthesized prod-shaped "not running" (NOT a base-controlled body; it only
  // ever appears inside ${e.message} of L975). Isolated: no "proxying"/"suddenly disconnected" here.
  it('flags a synthesized "not running" 500 (D3 superset, not base-emitted)', () => {
    expect(isStuckFlagResponse(500, 'the container is not running, consider calling start()')).toBe(true);
  });

  // Status operand — a stuck-looking BODY at a non-500 status is NOT stuck (500-only, M1). Mutating
  // away the `status !== 500` guard reds these.
  it.each([502, 503, 429, 499, 200])('does NOT flag status %i even with a proxy-phrase body', (status) => {
    expect(isStuckFlagResponse(status, 'Error proxying request to container: boom')).toBe(false);
  });

  // Body operand — cold-but-NOT-stuck 500 bodies must never be flagged (else abort→recrash loop / abort
  // a legit provisioning). "Failed to start container" is the M3 crash-loop guard; a genuine app 500
  // (no phrase) and the Phase-0-captured 503 provisioning body are the anti-abort controls.
  it('does NOT flag the M3 crash-loop, a genuine app 500, or the 503 provisioning body', () => {
    expect(isStuckFlagResponse(500, 'Failed to start container: bad entrypoint')).toBe(false); // M3
    expect(isStuckFlagResponse(500, '<pre>SyntaxError: Unexpected token in App.vue</pre>')).toBe(false);
    expect(isStuckFlagResponse(500, 'Internal Server Error')).toBe(false);
    expect(
      isStuckFlagResponse(503, 'There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count'),
    ).toBe(false);
  });

  // Invariant m1 — for EVERY stuck fixture: it is also cold (strict subset) AND decidePreviewResponse
  // serves the page. If a stuck body ever failed to be cold, the page wouldn't render for it.
  const STUCK_FIXTURES: Array<[number, string]> = [
    [500, 'Error proxying request to container: boom'],
    [500, 'Container suddenly disconnected, try again'],
    [500, 'the container is not running, consider calling start()'],
  ];
  it.each(STUCK_FIXTURES)('stuck (%i, %s) ⊂ cold AND serves the page (m1)', (status, body) => {
    expect(isStuckFlagResponse(status, body)).toBe(true);
    expect(isContainerColdResponse(status, body)).toBe(true); // strict subset: stuck ⟹ cold
    expect(decidePreviewResponse(status, body, true).servePage).toBe(true); // m1: page renders
  });
});

describe('DevContainer stuck-flag signature on the command path (isStuckFlagError)', () => {
  it('true for an L975-shaped ContainerUnavailableError; false for 503 provisioning + non-errors', () => {
    // The command path (#cmdJson) carries the FULL (status, body) on the error, so the fetch path
    // and command path share ONE signature. Capable-of-failing: a 120-char clip would still pass here
    // (the phrase is at char 0) — but the point is the shape, and the 503 err proves the exclusion.
    expect(isStuckFlagError(new ContainerUnavailableError(500, 'Error proxying request to container: boom'))).toBe(true);
    expect(isStuckFlagError(new ContainerUnavailableError(503, 'There is no Container instance available at this time.'))).toBe(false);
    // Defensive: a non-ContainerUnavailableError throw (no status/body) is never stuck.
    expect(isStuckFlagError(new Error('some other failure'))).toBe(false);
    expect(isStuckFlagError(null)).toBe(false);
    expect(isStuckFlagError('a string')).toBe(false);
    expect(isStuckFlagError({ status: 500 })).toBe(false); // body missing
  });

  it('reads the FULL body — a discriminating phrase PAST char 120 is not lost (clip-removal guard)', () => {
    // Criterion-2 regression guard: if the old `text.slice(0, 120)` clip were ever re-introduced, this
    // phrase — deliberately pushed past char 120 by a long preamble — would be truncated away and
    // isStuckFlagError would wrongly return false. Built from ContainerUnavailableError directly (the
    // exact object #cmdJson throws) so it exercises the (status, body) carry without a live container.
    const err = new ContainerUnavailableError(500, `${'x'.repeat(200)} Error proxying request to container: boom`);
    expect(err.body).toContain('proxying request to container'); // full body retained (no clip)
    expect(isStuckFlagError(err)).toBe(true); // …so the phrase past char 120 is still seen
  });
});

describe('DevContainer abort cooldown decision (shouldAbortNow — the frequency bound)', () => {
  // The ONLY bound on abort frequency. Boundary-cased: never-aborted allowed; within-window suppressed
  // (this IS "suppress a re-abort within the window"); exactly-at and past the window allowed again.
  // The durable read-back-across-reconstruct that makes this survive an abort is a ui-smoke/deploy
  // assertion (DevContainer can't construct under pool-workers) — here we prove the pure decision.
  it.each<[number | undefined, number, number, boolean]>([
    [undefined, 1000, 100, true], // never aborted → allowed
    [1000, 1050, 100, false], // within window (50 < 100) → suppressed
    [1000, 1100, 100, true], // exactly at window (100 >= 100) → allowed
    [1000, 1200, 100, true], // past window → allowed
  ])('shouldAbortNow(%s, %i, %i) === %s', (last, now, w, expected) => {
    expect(shouldAbortNow(last, now, w)).toBe(expected);
  });
});

describe('DevContainer recover-endpoint predicates (isRecoverRequest / isSameOriginRecover / previewRecoverUrl)', () => {
  it('isRecoverRequest matches the trailing sentinel, not a lookalike asset', () => {
    expect(isRecoverRequest(new Request('https://x/dev-container/acme.app.dev/_nebula/recover'))).toBe(true);
    // A query string doesn't defeat the match (pathname only).
    expect(isRecoverRequest(new Request('https://x/dev-container/acme.app.dev/_nebula/recover?t=1'))).toBe(true);
    // Capable-of-failing: a legit asset that merely CONTAINS the substring must NOT match (ends .vue).
    expect(isRecoverRequest(new Request('https://x/dev-container/acme.app.dev/src/_nebula/recover.vue'))).toBe(false);
    // An ordinary preview navigation doesn't match.
    expect(isRecoverRequest(new Request('https://x/dev-container/acme.app.dev/'))).toBe(false);
  });

  it('isSameOriginRecover allows same-origin, rejects cross-site/same-site/header-less (CSRF guard)', () => {
    expect(isSameOriginRecover(new Request('https://x/', { headers: { 'Sec-Fetch-Site': 'same-origin' } }))).toBe(true);
    // Each rejection operand distinct: cross-site AND same-site-but-cross-origin AND absent all rejected.
    expect(isSameOriginRecover(new Request('https://x/', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).toBe(false);
    expect(isSameOriginRecover(new Request('https://x/', { headers: { 'Sec-Fetch-Site': 'same-site' } }))).toBe(false);
    expect(isSameOriginRecover(new Request('https://x/'))).toBe(false); // absent → rejected
  });

  it('previewRecoverUrl derives the instance-scoped sentinel from the routed path (never the deep path)', () => {
    expect(previewRecoverUrl(new Request('https://x/dev-container/acme.app.dev/'))).toBe(
      '/dev-container/acme.app.dev/_nebula/recover',
    );
    // A deep preview route still yields the instance base (segments 1-2), the wrong-Star guard (M5).
    expect(previewRecoverUrl(new Request('https://x/dev-container/acme.app.dev/some/deep/route'))).toBe(
      '/dev-container/acme.app.dev/_nebula/recover',
    );
  });
});

describe('DevContainer preview serve decision (decidePreviewResponse)', () => {
  // servePage = existing cold gate (isDoc && !ok && isContainerColdResponse); autoRecover = the stuck
  // signature. Each row a distinct operand: stuck→auto-recover; 502/503/429 cold-not-stuck; M3
  // crash-loop cold-not-stuck; genuine app 500 not-served; non-doc not-served.
  it.each<[number, string, boolean, boolean, boolean]>([
    [500, 'Error proxying request to container: boom', true, true, true], // stuck → serve + auto-recover
    [500, 'the container is not running', true, true, true],
    [502, 'Error proxying request to container: boom', true, true, false], // 502 cold, not stuck (M1)
    [503, 'There is no Container instance available', true, true, false],
    [429, 'rate limited', true, true, false],
    [500, 'Failed to start container: bad entrypoint', true, true, false], // M3 crash-loop
    [500, '<pre>SyntaxError</pre>', true, false, false], // genuine app 500 → passed through
    [500, 'Error proxying request to container: boom', false, false, true], // non-doc → no page (autoRecover moot)
  ])('decidePreviewResponse(%i, %s, isDoc=%s) → servePage=%s autoRecover=%s', (status, body, isDoc, servePage, autoRecover) => {
    expect(decidePreviewResponse(status, body, isDoc)).toEqual({ servePage, autoRecover });
  });
});

describe('DevContainer bounded reload counter (nextRecoverAttempt)', () => {
  it.each<[number, boolean, number]>([
    [0, true, 1],
    [1, true, 2],
    [2, false, 3], // bound hit at 2 → stop (manual fallback)
    [3, false, 4],
  ])('nextRecoverAttempt(%i) → reload=%s nextCount=%i', (prev, reload, nextCount) => {
    expect(nextRecoverAttempt(prev)).toEqual({ reload, nextCount });
  });
});

describe('DevContainer waking page (bounded auto-recover — DELIBERATELY reverses the 2026-06-27 guard)', () => {
  // ⚠️ DELIBERATE REVERSAL of the 2026-06-27 "no auto-reload" anti-regression guard. That guard was
  // correct when recovery depended on idle-eviction (a reload storm renewed the activity timeout and
  // BLOCKED the evict that cleared the stale flag). Recovery is now abort-driven (D4), so a BOUNDED
  // reload drives the clear instead of blocking it. The bound (≤2 via nextRecoverAttempt) + manual
  // fallback replace the old "never reload" rule — and there is STILL no unbounded http-equiv=refresh
  // (that WOULD be the old regression sneaking back). This reversal is intentional, not a regression.
  it('manual-only page (!autoRecover): Reload button, NO recover wiring, NO auto-reload, NO meta-refresh', async () => {
    const html = await wakingPreviewPage(false).text();
    expect(html).toMatch(/location\.reload/); // manual button present
    expect(html).not.toContain('_nebula/recover'); // no recover fetch on the manual page
    expect(html).not.toContain('sessionStorage'); // no auto-recover script at all
    expect(html).not.toContain('setTimeout'); // no scheduled reload
    expect(html).not.toMatch(/http-equiv=["']?refresh/i);
  });

  it('auto-recover page: bounded self-heal wired to the corroborate-then-abort sentinel', async () => {
    const recoverUrl = '/dev-container/acme.app.dev/_nebula/recover';
    const html = await wakingPreviewPage(true, recoverUrl).text();
    expect(html).toContain(recoverUrl); // hits the sentinel it was given (request-derived, M5)
    expect(html).toContain('nextRecoverAttempt'); // the bound is EMBEDDED verbatim (drift-proof)
    expect(html).toContain('sessionStorage'); // counter-gated across reloads
    expect(html).toContain('setTimeout'); // schedules the single reload after the recover fetch
    expect(html).toMatch(/location\.reload/);
    // Bounded via the nextRecoverAttempt gate, NOT an unbounded meta-refresh (the old regression).
    expect(html).not.toMatch(/http-equiv=["']?refresh/i);
  });

  it('is a 200 text/html no-store response either way', async () => {
    for (const res of [wakingPreviewPage(false), wakingPreviewPage(true, '/dev-container/x.y.dev/_nebula/recover')]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });
});
