/**
 * Dev Star — P1 structural guard: NebulaClient has zero bare `'STAR'` binding
 * literals at its call sites; every Star-targeting call goes through the
 * `#starBinding()` choke point that picks `DEV_STAR` vs `STAR` from the active
 * scope's 3rd slug.
 *
 * This is the grep/AST guard from tasks/dev-star.md § P1 (client binding
 * selection). Capable-of-failing: re-introducing a single bare
 * `this.lmz.call('STAR', …)` / `callRaw('STAR', …)` site (the exact regression
 * this phase fixes — one missed site silently reads/writes the wrong namespace)
 * flips it RED. Lives in the `frontend` (Node/jsdom) project so it can read the
 * source as text; the BEHAVIORAL proof that the selection works lives in the
 * baseline `dev-star.test.ts` resource-identity test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The `frontend` vitest project runs in Node with cwd = the package root
// (apps/nebula). `import.meta.url` is an http:// URL under the vite dev server
// (not file://), so resolve from cwd instead.
const SRC = readFileSync(resolve(process.cwd(), 'src/nebula-client.ts'), 'utf8');

describe('NebulaClient Star-binding selection (dev-star P1)', () => {
  it('routes every Star call through #starBinding() — no bare \'STAR\' call-site literals', () => {
    // Both call shapes the 16 sites used. The only legitimate `'STAR'`/
    // `'DEV_STAR'` literals left are inside #starBinding()'s own return
    // expression (and prose comments), neither of which is a `.call(`/`.callRaw(`
    // site, so the call-site-anchored regexes below don't match them.
    expect(SRC).not.toMatch(/\.call\(\s*'STAR'/);
    expect(SRC).not.toMatch(/\.callRaw\(\s*'STAR'/);

    // Positive control: the choke point itself exists and the call sites invoke
    // it. (If #starBinding were deleted/renamed, the two assertions above could
    // pass vacuously on a file that simply stopped calling Star at all.)
    expect(SRC).toMatch(/#starBinding\(\)\s*:/); // the method declaration
    expect(SRC.match(/this\.#starBinding\(\)/g)?.length ?? 0).toBe(16); // all 16 sites
  });
});
