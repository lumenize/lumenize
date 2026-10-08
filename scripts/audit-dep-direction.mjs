#!/usr/bin/env node
/**
 * `npm run audit:dep-direction` — the package graph points one way: `@lumenize/mesh` imports neither
 * `@lumenize/resources` nor anything under `apps/`, and `@lumenize/resources` imports nothing under
 * `apps/` (`.claude/rules/mesh.md` § *Package dependency direction*). Mesh is MIT and published, the
 * plane is Nebula's and private, and the apps sit on both; an import pointing back up would ship
 * private code inside the MIT package, or tie the plane to one app.
 *
 * It scans every source and test file in `packages/mesh` and `packages/resources` and reads each
 * module reference with the TypeScript parser — `import`, `import type`, `export … from`, a dynamic
 * `import()` and an `import('…')` type — resolving a package name through the workspaces' manifests
 * and a relative path through the file system, so neither spelling hides an edge. It prints what it
 * checked on every run, so a pass is never an empty line.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Each scanned package and the workspaces it must not reach. */
const RULES = [
  { from: 'packages/mesh', forbidden: ['packages/resources', 'apps/'] },
  { from: 'packages/resources', forbidden: ['apps/'] },
];

/** Workspace directories by package name, from every manifest under packages/ and apps/. */
const WORKSPACES = new Map();
for (const parent of ['packages', 'apps']) {
  for (const name of readdirSync(join(ROOT, parent))) {
    const manifest = join(ROOT, parent, name, 'package.json');
    if (existsSync(manifest)) WORKSPACES.set(JSON.parse(readFileSync(manifest, 'utf8')).name, `${parent}/${name}`);
  }
}

function sourceFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (['node_modules', 'dist', 'coverage', '.wrangler'].includes(name)) continue;
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(m?[jt]s|tsx)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/** The workspace a module reference lands in, as a repo-relative directory, or `undefined` off the repo. */
function targetOf(file, spec) {
  if (spec.startsWith('.')) {
    const rel = relative(ROOT, resolve(dirname(file), spec)).split(sep).join('/');
    for (const dir of WORKSPACES.values()) if (rel === dir || rel.startsWith(`${dir}/`)) return dir;
    return rel;
  }
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return WORKSPACES.get(name);
}

/** Every module specifier a file names. */
function specifiers(file) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({ spec: node.moduleSpecifier.text, node });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      found.push({ spec: node.arguments[0].text, node });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      found.push({ spec: node.argument.literal.text, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found.map(({ spec, node }) => ({ spec, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 }));
}

const failures = [];
let files = 0;
let references = 0;
for (const rule of RULES) {
  for (const file of sourceFiles(rule.from)) {
    files++;
    for (const { spec, line } of specifiers(file)) {
      references++;
      const target = targetOf(file, spec);
      if (target && rule.forbidden.some((f) => (f.endsWith('/') ? target.startsWith(f) : target === f))) {
        failures.push(`${relative(ROOT, file)}:${line}: '${spec}' reaches ${target}, which ${rule.from} must not import`);
      }
    }
  }
}

console.log(`audit:dep-direction — ${files} files in ${RULES.map((r) => r.from).join(' and ')}, ${references} module references`);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('audit:dep-direction passed');
