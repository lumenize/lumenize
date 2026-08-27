/**
 * serve.ts — the `/app/*` static serve, encoded ONCE as a pure function so the store
 * can be Galaxy's SQLite VFS today and anything later (the `getFile` seam).
 *
 * The config is shaped like the Workers Assets stanza (`directory`,
 * `not_found_handling`) so there is ONE serving convention to learn: the same
 * match-first/SPA-fallback behavior Assets applies to `/studio/*`. Only the features
 * needed now are implemented — an unsupported config value THROWS rather than
 * silently no-oping. (One stated divergence: Assets manages Studio's caching via
 * ETags; this file implements the caching pin below — same effect, different
 * mechanism.)
 *
 * Behavior (the match-first rule):
 *  - a real file serves as itself, with its content type;
 *  - a miss — including any path with no file and any directory-ish path — serves
 *    `index.html` with 200 (`single-page-application`), so client-side routing owns
 *    deep links;
 *  - every serve of `index.html` (direct or fallback) gets
 *    `<base href="{config.base}">` prepended into `<head>` via `HTMLRewriter` — the
 *    scaffold builds with vite `base: './'`, and the injected element is what makes
 *    ONE build valid at any mount prefix (relative asset URLs resolve against it,
 *    not against the document's deep-link path).
 *
 * Caching pin (both tiers):
 *  - `index.html` and every unhashed file: `Cache-Control: no-store` — the un-hashed
 *    entry point names every hashed asset, and it differs per serve (the injected
 *    `<base>`), so a cached copy is a stale-names machine.
 *  - vite's content-hashed assets (`assets/name-{hash}.ext`): `public,
 *    max-age=31536000, immutable` — a content change changes the NAME.
 *
 * Containment (the route is deliberately ungated, so this is its ONE security
 * property): `getFile` reads a VFS that also holds the full source tree and git
 * objects. Traversal shapes (`..%2f`, `..%5c`, a leading `//`) survive WHATWG
 * pathname normalization, so the DECODED path is re-resolved segment-by-segment
 * here and anything escaping `directory` answers the SPA fallback — never outside
 * bytes.
 */

/** Shaped like the Workers Assets stanza, plus the mount prefix the serve is at. */
export interface ServeAppConfig {
  /** VFS directory holding the built app (the stanza's `directory` analogue). */
  directory: string;
  /** Only `'single-page-application'` is implemented; any other value throws. */
  not_found_handling: 'single-page-application';
  /**
   * The public path prefix this serve is mounted at — `/app/{u}.{g}.{s}/` — which is
   * also exactly the injected `<base href>` value. Must end with `/`.
   */
  base: string;
}

/** The store seam — Galaxy's `ws.fs.readFile` today, anything later. `null` = no file. */
export type GetFile = (path: string) => Promise<Uint8Array | string | null>;

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

function contentType(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** vite content-hashes bundled files under `assets/` — the name IS the version. */
function isHashedAsset(rel: string): boolean {
  return /(^|\/)assets\/[^/]*-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(rel);
}

/**
 * Resolve the DECODED relative path inside `directory`, segment by segment. The
 * containment is STRUCTURAL: the result is always `directory` + resolved segments,
 * with every `.`/`..` consumed HERE — so the path handed to `getFile` never carries
 * a dot segment for the store's own resolver (a real filesystem resolves `..`) to
 * walk outside `directory` with. Returns `null` only for shapes that are not a
 * path at all (backslash separators — the `..%5c` escape spelling — and an
 * un-decodable percent sequence); the caller answers the SPA fallback, so a
 * traversal probe is indistinguishable from a deep link.
 */
function containedPath(directory: string, rawRel: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRel);
  } catch {
    return null;
  }
  // A backslash is never a legitimate separator in a vite artifact path; treating it
  // as one (Windows-style) is exactly the `..%5c` escape shape.
  if (decoded.includes('\\')) return null;
  const stack: string[] = [];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      stack.pop(); // popping an empty stack is a no-op — the join below stays rooted
      continue;
    }
    stack.push(seg);
  }
  const root = directory.replace(/\/+$/, '');
  return stack.length === 0 ? `${root}/index.html` : `${root}/${stack.join('/')}`;
}

function injectBase(response: Response, base: string): Response {
  return new HTMLRewriter()
    .on('head', {
      element(el) {
        el.prepend(`<base href="${base}">`, { html: true });
      },
    })
    .transform(response);
}

function fileResponse(
  body: Uint8Array | string,
  rel: string,
  cacheControl: string,
  head: boolean,
): Response {
  const headers = new Headers({
    'Content-Type': contentType(rel),
    'Cache-Control': cacheControl,
  });
  return new Response(head ? null : (body as BodyInit), { status: 200, headers });
}

/**
 * Serve one GET/HEAD request for the built app. Returns `null` when the request
 * path is not under `config.base` (composability — the caller falls through), a
 * 404 only when the app has no `index.html` at all (nothing was ever built —
 * pre-first-build; the route stays well-defined), and a 200 otherwise.
 */
export async function serveApp(
  request: Request,
  config: ServeAppConfig,
  getFile: GetFile,
): Promise<Response | null> {
  if (config.not_found_handling !== 'single-page-application') {
    throw new Error(
      `serveApp: unsupported not_found_handling ${JSON.stringify(config.not_found_handling)} — ` +
      `only 'single-page-application' is implemented`,
    );
  }
  if (!config.base.endsWith('/')) {
    throw new Error(`serveApp: config.base must end with '/' (got ${JSON.stringify(config.base)})`);
  }
  const head = request.method === 'HEAD';
  const { pathname } = new URL(request.url);
  if (pathname !== config.base.slice(0, -1) && !pathname.startsWith(config.base)) return null;
  const rawRel = pathname.startsWith(config.base) ? pathname.slice(config.base.length) : '';

  const serveIndex = async (): Promise<Response | null> => {
    const root = config.directory.replace(/\/+$/, '');
    const index = await getFile(`${root}/index.html`);
    if (index === null) {
      return new Response(head ? null : 'Not Found', { status: 404, headers: { 'Cache-Control': NO_STORE } });
    }
    return injectBase(fileResponse(index, 'index.html', NO_STORE, head), config.base);
  };

  const filePath = containedPath(config.directory, rawRel);
  if (filePath === null) return serveIndex(); // traversal probe ≡ deep link: never outside bytes
  const rel = filePath.slice(config.directory.replace(/\/+$/, '').length + 1);
  if (rel === 'index.html') return serveIndex();

  const body = await getFile(filePath);
  if (body === null) return serveIndex(); // SPA fallback — deep links land on the app
  return fileResponse(body, rel, isHashedAsset(rel) ? IMMUTABLE : NO_STORE, head);
}
