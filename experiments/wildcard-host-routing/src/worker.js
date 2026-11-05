// Throwaway: echoes how a *.lumenize.dev request reached this one Worker, so a curl or a
// browser can see which host, scope and headers arrived. Findings live in RESULTS.md.
const ZONE = 'lumenize.dev';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const host = url.hostname;
    const sub = host.endsWith(`.${ZONE}`) ? host.slice(0, -(ZONE.length + 1)) : '';

    // Right to left: universe, galaxy, Star — and a persona joined to the Star's label by `--`
    const rev = sub ? sub.split('.').reverse() : [];
    let persona = null;
    if (rev.length) {
      const star = rev[rev.length - 1].split('--');
      if (star.length === 2) {
        persona = star[0];
        rev[rev.length - 1] = star[1];
      }
    }

    // Names only — never cookie values
    const cookieNames = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((c) => c.split('=')[0].trim())
      .filter(Boolean);

    const body = {
      // Which Worker answered — set per deploy, so two routes on one zone can be told apart
      arm: env.ARM ?? null,
      host,
      path: url.pathname,
      scope: rev.join('.'),
      persona,
      secFetch: {
        site: request.headers.get('sec-fetch-site'),
        mode: request.headers.get('sec-fetch-mode'),
        dest: request.headers.get('sec-fetch-dest'),
      },
      cookieNames,
      tlsVersion: request.cf?.tlsVersion ?? null,
      colo: request.cf?.colo ?? null,
    };

    return new Response(JSON.stringify(body, null, 2), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'set-cookie': '__Host-experiment=1; Path=/; Secure; HttpOnly; SameSite=Lax',
      },
    });
  },
};
