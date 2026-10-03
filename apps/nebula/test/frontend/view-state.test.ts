/**
 * The pure decisions of the routing module (`apps/nebula-studio-ui/src/view-state.ts`): which
 * overlays a query names. No running system is involved, so this is one place `/live` is not the
 * default tier (`live.md`); the live half is `studio-overlays-by-url`.
 *
 * Retired with the browser-held return-to, `validReturnTo` and `returnTarget`: where a person was
 * now rides the login's `return_to`, which the server checks where it stores it
 * (`hosts-and-frames` limb 7, and `studio-overlays-by-url` limb 8 across browsers).
 */
import { describe, it, expect } from 'vitest';
import { parseOverlay, withOverlay } from '../../../nebula-studio-ui/src/view-state';

describe('parseOverlay / withOverlay', () => {
  it('round-trips every overlay and ignores unknown parameters', () => {
    const q = withOverlay('?utm=1', { profile: true, transcript: 'm1' });
    expect(q).toBe('?utm=1&profile&transcript=m1');
    expect(parseOverlay(q)).toEqual({ profile: true, transcript: 'm1', create: false, app: false });
    expect(withOverlay(q, { profile: false, transcript: undefined })).toBe('?utm=1');
    // An app's settings ride the URL like any other overlay a person would link to.
    expect(withOverlay('', { app: true })).toBe('?app');
    expect(parseOverlay('?app').app).toBe(true);
    expect(withOverlay('?app&create', { app: false })).toBe('?create');
  });
});
