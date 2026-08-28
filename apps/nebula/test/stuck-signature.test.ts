/**
 * The cloud-only container STUCK-flag signature, as pure predicates
 * (`isStuckFlagResponse` / `isStuckFlagError` — galaxy.ts).
 *
 * The ephemeral build-box designs the stuck state away (a container never outlives its
 * build), so nothing ACTS on these anymore — they exist purely as EVIDENCE: the build
 * drive logs any match via `@lumenize/debug` and expects zero
 * ([[cf-container-stuck-flag-cloud]]). A predicate that over-matches would log noise
 * that reads as the rare cloud race; one that under-matches would silently discard the
 * one signal that could ever reopen the `ctx.abort()` question — so both operand sets
 * stay mutation-checked.
 */
import { describe, it, expect } from 'vitest';
import { isStuckFlagResponse, isStuckFlagError, isStuckFlagText } from '../src/galaxy';

describe('stuck-flag signature (isStuckFlagResponse)', () => {
  // Phrase operand 1 — the runtime proxy-error literal "Error proxying request to container:".
  // Isolated: this body carries none of the other two phrases, so deleting that alternative
  // from the regex reds ONLY this.
  it('flags the proxy-error 500 (primary runtime phrase)', () => {
    expect(isStuckFlagResponse(500, 'Error proxying request to container: boom')).toBe(true);
  });

  // Phrase operand 2 — "Container suddenly disconnected, try again". Isolated as above.
  it('flags the "suddenly disconnected" 500', () => {
    expect(isStuckFlagResponse(500, 'Container suddenly disconnected, try again')).toBe(true);
  });

  // Phrase operand 3 — the prod-shaped "not running" (rides inside the proxy error's
  // ${e.message} in the wild; synthesized here). Isolated as above.
  it('flags a "not running" 500', () => {
    expect(isStuckFlagResponse(500, 'the container is not running, consider calling start()')).toBe(true);
  });

  // Status operand — a stuck-looking BODY at a non-500 status is NOT stuck (500-only).
  // Mutating away the `status !== 500` guard reds these.
  it.each([502, 503, 429, 499, 200])('does NOT flag status %i even with a proxy-phrase body', (status) => {
    expect(isStuckFlagResponse(status, 'Error proxying request to container: boom')).toBe(false);
  });

  // Body operand — non-stuck 500 bodies must never be flagged (they would log false
  // evidence of the rare cloud race): a crash-on-boot, a genuine app 500, provisioning.
  it('does NOT flag a crash-on-boot, a genuine app 500, or the 503 provisioning body', () => {
    expect(isStuckFlagResponse(500, 'Failed to start container: bad entrypoint')).toBe(false);
    expect(isStuckFlagResponse(500, '<pre>SyntaxError: Unexpected token in App.vue</pre>')).toBe(false);
    expect(isStuckFlagResponse(500, 'Internal Server Error')).toBe(false);
    expect(
      isStuckFlagResponse(503, 'There is no Container instance available at this time.'),
    ).toBe(false);
  });
});

describe('stuck-flag signature over a thrown error (isStuckFlagError)', () => {
  const errWith = (status: number, body: string) => Object.assign(new Error('container error'), { status, body });

  it('true for a (500, proxy-phrase) error; false for provisioning + non-carriers', () => {
    expect(isStuckFlagError(errWith(500, 'Error proxying request to container: boom'))).toBe(true);
    expect(isStuckFlagError(errWith(503, 'There is no Container instance available at this time.'))).toBe(false);
    // Defensive: a throw with no (status, body) carry is never stuck.
    expect(isStuckFlagError(new Error('some other failure'))).toBe(false);
    expect(isStuckFlagError(null)).toBe(false);
    expect(isStuckFlagError('a string')).toBe(false);
    expect(isStuckFlagError({ status: 500 })).toBe(false); // body missing
  });

  it('reads the FULL body — a discriminating phrase past char 120 is still seen (clip guard)', () => {
    // A caller that clipped the body before attaching it would truncate the phrase away
    // and this would wrongly return false — the historical 120-char-clip regression.
    const err = errWith(500, `${'x'.repeat(200)} Error proxying request to container: boom`);
    expect(isStuckFlagError(err)).toBe(true);
  });
});

/**
 * The phrase set alone — what the BUILD DRIVE's catch tests, where a thrown error carries
 * only a `message` and the status guard cannot apply. It is the same source the
 * status-gated predicate above delegates to; spelled inline at the drive it was an
 * untested second copy of the signature, on the branch that decides whether the
 * expect-zero evidence marker fires.
 */
describe('stuck-flag phrases (isStuckFlagText — the status-free arm)', () => {
  it.each([
    'Error proxying request to container: boom',
    'Container suddenly disconnected, try again',
    'container is not running',
  ])('matches the drive-side phrase: %s', (message) => {
    expect(isStuckFlagText(message)).toBe(true);
  });

  it('does NOT match an ordinary build failure — the marker must stay at zero for those', () => {
    expect(isStuckFlagText('Rollup failed: src/App.vue (3:7) Unexpected token')).toBe(false);
    expect(isStuckFlagText('Failed to start container')).toBe(false); // crash-on-boot ≠ stuck
  });
});
