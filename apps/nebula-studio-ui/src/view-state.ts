/**
 * THE URL — read in one place, written by one function (ADR-017; `.claude/rules/ui-routing.md`).
 *
 * What a person is LOOKING AT rides the URL: the scope in the HOST (`crm.acme.lumenize.dev` is
 * `acme.crm`, ADR-021), and the overlays in the query (`?profile`, `?transcript={messageId}`,
 * `?create`, `?app`). An overlay someone would send a
 * link to has the URL as its ONLY opener: a button navigates, Back closes, a reload keeps it, and
 * the page renders it from the URL — or declines it when the state does not allow. What a person
 * is DOING — a menu, a confirmation, a toast, work in flight — never touches the URL.
 *
 * Two kinds of move, deliberately distinct:
 *  - `navigate` changes view state in the SAME document through the History API — no request, no
 *    reload. Our own `pushState` fires no event (by spec), so this writer updates `viewState`
 *    itself; the browser's own moves (Back, Forward) fire `popstate`, and the one listener below
 *    re-reads. Two paths in, one reactive source out.
 *  - `leaveTo` goes to ANOTHER document — into an app, to login, to Home. A different scope is a
 *    different socket and token, and the auth screens are a different bundle, so a full load is
 *    the honest move. It exists so those moves are visible and countable, not scattered.
 *
 * Nothing outside this file touches `location` or `history`; `npm run audit:urls` proves it.
 * The decision of which overlays exist is `parseOverlay`, one pure function a test can flip.
 */
import { readonly, shallowRef } from 'vue';
import { deploymentOriginOfPage, hostOrigin, parseHost, type HostTarget } from '@lumenize/nebula/frontend';

/** Every overlay the shell knows. `transcript` carries the message id whose stream it shows. */
export interface Overlay {
  profile: boolean;
  transcript?: string;
  create: boolean;
  /** An app's settings — its tenants, and the app's own delete. */
  app: boolean;
}

/** The URL as view state. Derive from it with `computed`; never read `location` directly. */
export interface ViewState {
  pathname: string;
  /** The whole query, for a page that reads a parameter no overlay carries (`token`, `return_to`). */
  search: string;
  overlay: Overlay;
}

const FLAGS = ['profile', 'create', 'app'] as const;

/** The overlays a URL's query names. Unknown parameters are ignored, not errors. */
export function parseOverlay(search: string): Overlay {
  const q = new URLSearchParams(search);
  return {
    profile: q.has('profile'),
    transcript: q.get('transcript') ?? undefined,
    create: q.has('create'),
    app: q.has('app'),
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

const hasWindow = typeof window !== 'undefined';
const read = (): ViewState => ({
  pathname: hasWindow ? location.pathname : '/',
  search: hasWindow ? location.search : '',
  overlay: parseOverlay(hasWindow ? location.search : ''),
});

// ── The host: which page this is, and how to spell another one ──────────────────────────────────
// A page's host never changes under it, so these are read once. The deployment's origin comes from
// the `lumenize-origin` meta the serving layer puts on every page; the port is this page's own.
const deployment = deploymentOriginOfPage();

/** What this page's host is — a scope's, the platform host, or neither. */
export const pageHost: HostTarget | null = hasWindow && deployment ? parseHost(location.host, deployment) : null;

/** The scope this page's host spells, or `undefined` off a scope host. */
export const pageScope: string | undefined = pageHost?.kind === 'scope' ? pageHost.scope : undefined;

/** A URL on `scope`'s own host. */
export function scopeUrl(scope: string, path = '/'): string {
  return `${hostOrigin({ kind: 'scope', scope }, deployment ?? '', hasWindow ? location.origin : undefined)}${path}`;
}

/** A URL on the platform host, where every session's routes and pages live. */
export function platformUrl(path: string): string {
  return `${hostOrigin({ kind: 'platform' }, deployment ?? '', hasWindow ? location.origin : undefined)}${path}`;
}

/** This page's whole URL, fragment included — what a login is asked to return to. */
export function currentUrl(): string {
  return hasWindow ? location.href : '';
}

const state = shallowRef<ViewState>(read());

/** The current URL as view state — the ONLY reader. Reactive; derive with `computed`. */
export const viewState = readonly(state);

/** Entries this page pushed above the URL it arrived on — what `navigate` may `back()` over. */
let pushed = 0;

/**
 * Change the overlays in the SAME document — the ONLY same-document writer. Opening pushes a
 * history entry so Back closes it; closing goes back over an entry this page pushed, and otherwise
 * rewrites in place (a direct arrival at `?profile` has no entry of ours beneath it). `replace`
 * opens without an entry — for a state the page derives rather than a person chooses, such as the
 * empty account's create form, where Back over a pushed entry would only reopen it.
 */
export function navigate(patch: Partial<Overlay>, opts: { replace?: boolean } = {}): void {
  const next = withOverlay(location.search, patch);
  if (next === location.search) return;
  const url = location.pathname + next + location.hash;
  if (opensSomething(patch) && !opts.replace) {
    history.pushState(null, '', url);
    pushed++;
  } else if (!opensSomething(patch) && pushed > 0) {
    pushed--;
    history.back(); // popstate re-reads the URL
    return;
  } else {
    history.replaceState(null, '', url);
  }
  state.value = read();
}

/**
 * Drop query parameters in place, with no history entry — for a value the URL must not keep once
 * read, such as a link's token, so neither a replay nor browser history carries it.
 */
export function forgetQuery(names: string[]): void {
  const q = new URLSearchParams(location.search);
  for (const n of names) q.delete(n);
  const s = q.toString();
  history.replaceState(null, '', location.pathname + (s ? `?${s}` : '') + location.hash);
  state.value = read();
}

/**
 * Go to ANOTHER document — the ONLY cross-document move. A full load, on purpose (see above). Where
 * a person was when they left for a login rides the login's `return_to`, which the server checks and
 * stores with the link, so nothing here remembers it.
 */
export function leaveTo(url: string): void {
  location.assign(url);
}

if (hasWindow) {
  window.addEventListener('popstate', () => {
    state.value = read();
    // Back past our last pushed entry lands on the page's own URL — nothing of ours is left above it.
    if (!opensSomething(state.value.overlay)) pushed = 0;
  });
}
