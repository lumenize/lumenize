/**
 * serve.ts — the pure `/app/*` static serve, against a fake `getFile` (the seam is
 * the point: these tests pin the whole serving contract before any Galaxy branch
 * exists). Pool-workers (the `unit` project) so the real workerd `HTMLRewriter`
 * performs the `<base>` injection — jsdom has no HTMLRewriter, which is why this
 * cannot be a Node unit test.
 */
import { describe, it, expect } from 'vitest';
import { serveApp, type ServeAppConfig, type GetFile } from '../src/serve';

const BASE = '/app/acme.crm.dev/';
const CONFIG: ServeAppConfig = {
  directory: '/dist',
  not_found_handling: 'single-page-application',
  base: BASE,
};

const FILES: Record<string, string> = {
  '/dist/index.html': '<!doctype html><html><head><title>t</title></head><body></body></html>',
  '/dist/assets/index-AbCdEf12.js': 'console.log("app")',
  '/dist/assets/index-ZyXwVu98.css': 'body{}',
  '/dist/favicon.ico': 'ICON',
  // The workspace holds the SOURCE TREE too — the bytes containment must never serve.
  '/src/secret.ts': 'const apiShape = "workspace source";',
};
// FILESYSTEM-FAITHFUL: a real store (`ws.fs.readFile`) resolves `.`/`..` in the path it
// is handed — an exact-string fake is the SAFE SHAPE that lets a pass-through resolver
// look contained (`/dist/../src/secret.ts` would "miss"). Resolve dots exactly the way
// a filesystem would, so an escaping path genuinely reaches the outside bytes.
const getFile: GetFile = async (path) => {
  const stack: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { stack.pop(); continue; }
    stack.push(seg);
  }
  return FILES['/' + stack.join('/')] ?? null;
};

const req = (path: string, method = 'GET') =>
  new Request(`https://nebula.example${path}`, { method });

describe('serveApp — match-first + SPA fallback', () => {
  it('a real file serves as itself with its content type; hashed assets are immutable', async () => {
    const js = await serveApp(req(`${BASE}assets/index-AbCdEf12.js`), CONFIG, getFile);
    expect(js!.status).toBe(200);
    expect(js!.headers.get('Content-Type')).toContain('text/javascript');
    expect(js!.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await js!.text()).toBe('console.log("app")');

    const css = await serveApp(req(`${BASE}assets/index-ZyXwVu98.css`), CONFIG, getFile);
    expect(css!.headers.get('Content-Type')).toContain('text/css');
    expect(css!.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('an UNHASHED real file (a public/ copy) serves no-store', async () => {
    const ico = await serveApp(req(`${BASE}favicon.ico`), CONFIG, getFile);
    expect(ico!.status).toBe(200);
    expect(ico!.headers.get('Cache-Control')).toBe('no-store');
  });

  it('the app root serves index.html no-store WITH the injected <base>', async () => {
    const res = await serveApp(req(BASE), CONFIG, getFile);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Content-Type')).toContain('text/html');
    expect(res!.headers.get('Cache-Control')).toBe('no-store');
    const html = await res!.text();
    expect(html).toContain(`<base href="${BASE}">`);
    // Prepended INTO head — before the title, so relative URLs resolve against it.
    expect(html.indexOf('<base')).toBeLessThan(html.indexOf('<title>'));
  });

  it('a miss — a deep link — serves index.html (SPA fallback) with the <base> injected', async () => {
    const res = await serveApp(req(`${BASE}invoices/42`), CONFIG, getFile);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Content-Type')).toContain('text/html');
    expect(await res!.text()).toContain(`<base href="${BASE}">`);
  });

  it('a missing ASSET-looking path also serves index.html', async () => {
    const res = await serveApp(req(`${BASE}assets/gone-12345678.js`), CONFIG, getFile);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Content-Type')).toContain('text/html');
  });

  it('HEAD serves headers with no body', async () => {
    const res = await serveApp(req(`${BASE}assets/index-AbCdEf12.js`, 'HEAD'), CONFIG, getFile);
    expect(res!.status).toBe(200);
    expect(res!.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await res!.text()).toBe('');
  });

  it('a path outside the base returns null (caller falls through)', async () => {
    expect(await serveApp(req('/studio/acme.crm'), CONFIG, getFile)).toBeNull();
  });

  it('no index.html at all (nothing built yet) → 404, never a throw', async () => {
    const empty: GetFile = async () => null;
    const res = await serveApp(req(BASE), CONFIG, empty);
    expect(res!.status).toBe(404);
  });

  it('an unsupported not_found_handling THROWS rather than silently no-oping', async () => {
    const bad = { ...CONFIG, not_found_handling: 'none' as never };
    await expect(serveApp(req(BASE), bad, getFile)).rejects.toThrow(/unsupported not_found_handling/);
  });
});

describe('serveApp — containment (the route is ungated; this is its ONE security property)', () => {
  // The VFS also holds the full source tree + git objects: every traversal shape must
  // resolve inside `directory` or answer index.html — NEVER outside bytes.
  it.each([
    ['encoded dot-dot slash', `${BASE}..%2fsrc%2fsecret.ts`],
    ['encoded dot-dot backslash', `${BASE}..%5csrc%5csecret.ts`],
    ['plain dot-dot beyond root', `${BASE}a/../../src/secret.ts`],
    ['double-encoded', `${BASE}%252e%252e%2fsrc%2fsecret.ts`],
    ['leading double slash', `//app/acme.crm.dev/../src/secret.ts`],
  ])('%s never yields workspace source', async (_name, path) => {
    const res = await serveApp(req(path), CONFIG, getFile);
    if (res === null) return; // fell outside the base entirely — nothing served
    const text = await res.text();
    expect(text).not.toContain('workspace source');
    // What IS served is the SPA fallback (or a real in-dist file) — inside bytes only.
    expect([200, 404]).toContain(res.status);
  });

  it('a traversal that stays INSIDE the directory still resolves (a/../ is a legal no-op)', async () => {
    const res = await serveApp(req(`${BASE}a/../favicon.ico`), CONFIG, getFile);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe('ICON');
  });
});
