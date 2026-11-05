/**
 * The meta every Lumenize page carries — Studio, a universe page, the auth app and a built app —
 * naming the deployment's origin, so its client can spell the platform host and every scope's host:
 * `<meta name="lumenize-origin" content="https://lumenize.dev">`. The port is the page's own, so a
 * local stack's pages need no other value.
 */
export const LUMENIZE_ORIGIN_META = 'lumenize-origin';
