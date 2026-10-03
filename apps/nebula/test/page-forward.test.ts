/**
 * The page track into a Durable Object's `fetch` keeps a request on its track.
 *
 * In-lane, and no running system is needed: `publicRequest` is a pure request-to-request function,
 * so each property is a fact about the `Request` it returns. What the forwarded request REACHES — a
 * page load of `/api` getting the app, the planted header naming no Galaxy — is the `/live` half, in
 * `build-box`.
 */
import { describe, it, expect } from 'vitest';
import { publicRequest, PUBLIC_SCOPE_HEADER } from '../src/page-forward';

const target = { binding: 'GALAXY', instanceName: 'acme.crm', scope: 'acme.crm.dev' };
const page = (path: string, init?: RequestInit) => new Request(`https://dev.crm.acme.lumenize.dev${path}`, init);

describe('the page helper keeps a request on its track', () => {
  it('drops every x-lumenize-* header the client sent, and sets its own', () => {
    const out = publicRequest(page('/', {
      headers: { 'x-lumenize-planted': 'yes', 'x-lumenize-do-instance-name-or-id': 'evil.x', accept: 'text/html' },
    }), target) as Request;
    expect(out.headers.get('x-lumenize-planted')).toBeNull();
    expect(out.headers.get('x-lumenize-do-instance-name-or-id')).toBe('acme.crm');
    expect(out.headers.get('x-lumenize-do-binding-name')).toBe('GALAXY');
    expect(out.headers.get(PUBLIC_SCOPE_HEADER)).toBe('acme.crm.dev');
    expect(out.headers.get('accept')).toBe('text/html');
  });

  it('refuses an Upgrade with its own message', async () => {
    const out = publicRequest(page('/api', { headers: { Upgrade: 'websocket' } }), target);
    expect(out).toBeInstanceOf(Response);
    expect((out as Response).status).toBe(426);
    expect(await (out as Response).text()).toBe('A page request is never upgraded');
  });

  it('answers anything but GET and HEAD with 405 naming them', () => {
    const out = publicRequest(page('/', { method: 'POST', body: '{}' }), target) as Response;
    expect(out.status).toBe(405);
    expect(out.headers.get('Allow')).toBe('GET, HEAD');
    expect(publicRequest(page('/', { method: 'HEAD' }), target)).toBeInstanceOf(Request);
  });

  it('moves the path under /_public, which no other caller produces', () => {
    expect(new URL((publicRequest(page('/api'), target) as Request).url).pathname).toBe('/_public/api');
    // Positive control: an ordinary asset path moves the same way.
    expect(new URL((publicRequest(page('/assets/app.js?v=1'), target) as Request).url).pathname)
      .toBe('/_public/assets/app.js');
  });
});
