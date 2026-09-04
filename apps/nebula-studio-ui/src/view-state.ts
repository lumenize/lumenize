/**
 * Overlays are view state, and the URL is their ONLY opener (ADR-017 § *Decision*).
 *
 * A modal or panel a person would send a link to — "change your nickname here", "look at what it
 * was thinking on this turn" — is what they are looking at, so it rides the URL like a tab or a
 * filter: a button navigates, Back closes, a reload keeps it, and the page renders it from the URL
 * (and declines it when the current state does not allow — a signed-out visitor to `?profile` gets
 * the landing). What a person is DOING — a menu, a confirmation, a toast, work in flight — never
 * touches the URL, because the URL names WHAT, never an action.
 *
 * Query parameters, not path segments: an overlay sits over a page and composes with that page's
 * other view state. The decision of which overlays exist is `parseOverlay`, one function, so a
 * scenario can reach every overlay by navigation and a test can flip the mapping.
 */

/** Every overlay the shell knows. `transcript` carries the message id whose stream it shows. */
export interface Overlay {
  profile: boolean;
  manage: boolean;
  transcript?: string;
  create: boolean;
}

const FLAGS = ['profile', 'manage', 'create'] as const;

/** The overlays a URL's query names. Unknown parameters are ignored, not errors. */
export function parseOverlay(search: string): Overlay {
  const q = new URLSearchParams(search);
  return {
    profile: q.has('profile'),
    manage: q.has('manage'),
    transcript: q.get('transcript') ?? undefined,
    create: q.has('create'),
  };
}

/** The query string with `patch` applied: `false`/`undefined` removes a parameter. */
export function withOverlay(search: string, patch: Partial<Overlay>): string {
  const q = new URLSearchParams(search);
  for (const k of FLAGS) {
    if (!(k in patch)) continue;
    if (patch[k]) q.set(k, ''); else q.delete(k);
  }
  if ('transcript' in patch) {
    if (patch.transcript) q.set('transcript', patch.transcript); else q.delete('transcript');
  }
  // `profile=` reads worse than `profile`; the parser treats both alike.
  const s = q.toString().replace(/=(?=&|$)/g, '');
  return s ? `?${s}` : '';
}

/** True when `patch` opens something (as opposed to only closing). */
export function opensSomething(patch: Partial<Overlay>): boolean {
  return Object.values(patch).some((v) => v !== false && v !== undefined);
}
