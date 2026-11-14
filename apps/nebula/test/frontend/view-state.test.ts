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
import { parseOverlay, parsePreviewTabs, withView } from '../../../nebula-studio-ui/src/view-state';

describe('parseOverlay / parsePreviewTabs / withView', () => {
  it('round-trips every overlay and ignores unknown parameters', () => {
    const q = withView('?utm=1', { profile: true, transcript: 'm1' });
    expect(q).toBe('?utm=1&profile&transcript=m1');
    expect(parseOverlay(q)).toEqual({ profile: true, transcript: 'm1', create: false, app: false });
    expect(withView(q, { profile: false, transcript: undefined })).toBe('?utm=1');
    // An app's settings ride the URL like any other overlay a person would link to.
    expect(withView('', { app: true })).toBe('?app');
    expect(parseOverlay('?app').app).toBe(true);
    expect(withView('?app&create', { app: false })).toBe('?create');
  });

  // The preview's tabs: the one in view and the closed ones ride the URL as slugs, and an empty
  // list leaves the URL. Mutation: drop the empty-list branch, and `closed=` stays behind.
  it('round-trips the preview tabs, as slugs joined by a comma', () => {
    const q = withView('?profile', { tab: 'sally', closed: ['gerry', 'olga'] });
    expect(q).toBe('?profile&tab=sally&closed=gerry,olga');
    expect(parsePreviewTabs(q)).toEqual({ tab: 'sally', closed: ['gerry', 'olga'] });
    expect(withView(q, { tab: undefined, closed: [] })).toBe('?profile');
    expect(parsePreviewTabs('')).toEqual({ tab: undefined, closed: [] });
  });

  // Each slug becomes a host Studio frames, so only a persona slug counts. Mutation: take the URL's
  // tab as given, and the first case frames evil.example.
  it('names no tab the URL spells as anything but a persona slug', () => {
    expect(parsePreviewTabs('?tab=evil.example%2Fx%23')).toEqual({ tab: undefined, closed: [] });
    expect(parsePreviewTabs('?tab=x%40evil.example%2F&closed=sally,evil.example%3F,ed')).toEqual({ tab: undefined, closed: ['sally'] });
  });
});
