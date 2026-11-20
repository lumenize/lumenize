/**
 * The Star the chromium lane's test page sits on. Vitest opens every test at
 * `http://tenant-a.crm.acme.lumenize.localhost:<port>/` (the project's `browser.api.host` in
 * `vitest.config.js`), and a page acts only at the scope its host spells, so this is the scope of
 * every client the lane constructs. The global setup claims it as its own admin.
 *
 * Kept in a module of its own so the Node-side setup can import it without the browser bundle.
 */
export const PAGE_STAR = 'acme.crm.tenant-a';
