/**
 * Rewrite the compiled SFC module's bare import specifiers to the same-origin
 * platform paths the served app resolves under a strict `script-src 'self'`
 * (no import map). Applied at the DevStar compile/write boundary
 * (`DevStar.compileSFC`), NOT in the shared `compile-module.ts` — which keeps
 * emitting canonical bare specifiers so the jsdom compile test's own
 * bare-`vue`→stub rewrite and the documented `CompileModuleResult.module`
 * contract stay untouched.
 *
 * Allowlist (the ONLY bare specifiers a served app may import):
 *   - `vue`                          → `./vue.js`                  (root scaffold shim → vendored runtime)
 *   - `lucide-vue-next/icons/<name>` → `./vendor/lucide/<name>.js` (one served file per icon)
 *
 * Any other bare specifier is a compile error returned to the caller (feeding
 * Studio's iterate-on-errors loop) — never silently emitted, because an
 * unrewritten bare specifier under `script-src 'self'` is a silent same-origin
 * 404 at runtime. Relative (`./`, `../`), absolute (`/`), and URL specifiers
 * are left untouched.
 */

const LUCIDE_ICON_PREFIX = 'lucide-vue-next/icons/';

export interface SpecifierRewriteResult {
  /** The module with allowlisted bare specifiers rewritten. Meaningful only when `errors` is empty. */
  code: string;
  /** Non-empty iff a non-allowlisted bare specifier was found; `code` is then unusable. */
  errors: string[];
}

function isBare(spec: string): boolean {
  return !spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(spec);
}

/**
 * Map one bare specifier to its served path, or `null` if not allowlisted.
 * Lucide icon names must be a single kebab segment (no nested path / traversal).
 */
function rewriteBare(spec: string): string | null {
  if (spec === 'vue') return './vue.js';
  if (spec.startsWith(LUCIDE_ICON_PREFIX)) {
    const name = spec.slice(LUCIDE_ICON_PREFIX.length);
    if (/^[a-z0-9-]+$/.test(name)) return `./vendor/lucide/${name}.js`;
  }
  return null;
}

/**
 * Rewrite every `import …`/`export … from '<spec>'` (and bare side-effect
 * `import '<spec>'`) in the assembled ESM, in both quote styles
 * `@vue/compiler-sfc` + `transpileModule` emit.
 *
 * **Line-anchored on purpose.** `transpileModule` collapses every import to a
 * single line, so anchoring each match to a line that *starts* with
 * `import`/`export` (the `m` flag) is complete — and it avoids the false-positive
 * a blind `from ['"]…['"]` scan would hit on a `from "vue"` substring inside a
 * string literal (those sit on `const …`/expression lines, never line-start
 * `import`/`export`).
 */
export function rewriteServedSpecifiers(module: string): SpecifierRewriteResult {
  const errors: string[] = [];
  const handle = (match: string, head: string, quote: string, spec: string): string => {
    if (!isBare(spec)) return match;
    const target = rewriteBare(spec);
    if (target === null) {
      errors.push(
        `Unsupported bare import '${spec}' — a served Nebula app may only import 'vue' or ` +
        `'lucide-vue-next/icons/<name>' (other packages aren't self-hosted under script-src 'self').`,
      );
      return match;
    }
    return `${head}${quote}${target}${quote}`;
  };
  const code = module
    // `import … from '<spec>'` / `export … from '<spec>'` (no quote/newline before `from`).
    .replace(/^([ \t]*(?:import|export)\b[^'"\n]*\bfrom[ \t]*)(['"])([^'"\n]+)\2/gm, handle)
    // Bare side-effect `import '<spec>'` (a quote immediately after `import`).
    .replace(/^([ \t]*import[ \t]*)(['"])([^'"\n]+)\2/gm, handle);
  return { code, errors };
}
