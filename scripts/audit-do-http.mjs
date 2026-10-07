#!/usr/bin/env node
/**
 * `npm run audit:do-http` — what reaches a Durable Object's `fetch`, and what our code calls on a stub.
 *
 * A mesh node's `fetch` hears from four kinds of caller, and each keeps a track of its own
 * (`.claude/rules/raw-comm.md` § *What reaches a Durable Object's `fetch`*, ADR-007, ADR-023): pages
 * only under `/_public/`, through one forward; a Client's upgrade only under `/gateway/`, which the
 * Worker rewrites from the hostname; our own code by `rawRpcStub`, never `fetch`; and a node's own
 * container at the paths its library fixes. Nothing keeps those apart at runtime but the
 * paths each forward produces, so this scans source — every `src` tree under `apps/`, and `packages/nebula-auth/src`,
 * never tests — and checks four things:
 *
 *   1. Every member `.fetch(` is a named forward, or names a binding the generated `Env` declares as
 *      something other than a Durable Object namespace.
 *   2. Every `routeDORequest` call under `apps/` passes `bindings`.
 *   3. Every mesh node's `onRequest` (or `fetch` override) compares the path only against the
 *      prefixes its class registers in a static `HTTP_PREFIXES`.
 *   4. No Durable Object stub is made except in a named forward or, inside nebula-auth, for its own
 *      Registry. Everything else reaches a node over the mesh or through `rawRpcStub`, which makes
 *      its stub inside mesh — so an inline `getByName(…).teardown()` that skips the entry fails here.
 *
 * The named forwards: the page track (`forwardPage`), nebula-auth's Registry forward (`forwardRaw`),
 * and two outside this scan — `routeDORequest` in `@lumenize/routing`, whose `/gateway/` upgrade to
 * the scope's node a host spells check 2 bounds, and
 * `@cloudflare/computer`'s `WorkspaceProxy`, which dials the Galaxy's `/api`.
 *
 * It prints what it checked on every run, so an empty failure list is never the only output.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Functions a Durable Object's `fetch` may be called from, and where a stub may be made. */
const NAMED_FORWARDS = [
  { file: 'apps/nebula/src/page-forward.ts', fn: 'forwardPage', what: 'the page track' },
  { file: 'packages/nebula-auth/src/router.ts', fn: 'forwardRaw', what: "nebula-auth's Registry forward" },
];

/** Member `.fetch(` sites whose receiver is a Fetcher or a service, checked against the generated `Env`. */
const NOT_DURABLE_OBJECTS = [
  { file: 'apps/nebula/src/entrypoint.ts', fn: 'assets', binding: 'ASSETS' },
  { file: 'apps/nebula/src/entrypoint.ts', fn: 'fetch', binding: 'PLATFORM_HOST' },
  { file: 'packages/nebula-auth/src/router.ts', fn: 'serveAuthApp', binding: 'ASSETS' },
];

/** The generated `Env` of the Worker that hosts every binding above. */
const ENV_DECLARATIONS = 'apps/nebula/worker-configuration.d.ts';

/** Base classes whose `fetch` is not a mesh node's. */
const NON_MESH_BASES = new Set(['DurableObject', 'WorkerEntrypoint', 'LumenizeWorker']);

/** Methods that make a Durable Object stub or the id one is made from. */
const STUB_MAKERS = new Set(['getByName', 'idFromName', 'idFromString', 'newUniqueId', 'getExisting']);

const failures = [];
const fail = (file, node, message) => {
  const { line } = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
  failures.push(`${file}:${line + 1}: ${message}`);
};

function sourceFiles() {
  const out = [];
  const walk = (dir, inSrc) => {
    for (const name of readdirSync(dir)) {
      if (['node_modules', 'dist', '.wrangler', 'test', 'tests'].includes(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, inSrc || name === 'src');
      else if (inSrc && name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(relative(ROOT, path));
    }
  };
  walk(join(ROOT, 'apps'), false);
  walk(join(ROOT, 'packages/nebula-auth/src'), true);
  return out.sort();
}

/** The name of the nearest named function around `node`, or `undefined` at module scope. */
function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      && (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent))) return n.parent.name.getText();
  }
  return undefined;
}

const isNamedForward = (file, fn) => NAMED_FORWARDS.some((f) => f.file === file && f.fn === fn);

/** A compared path operand, reduced so `'/_public/'`, `PUBLIC_PREFIX` and `${PUBLIC_PREFIX}/` line up. */
function pathKey(expr) {
  while (ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr) || ts.isSatisfiesExpression?.(expr)) {
    expr = expr.expression;
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text.replace(/\/$/, '');
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) return expr.getText();
  if (ts.isTemplateExpression(expr) && expr.head.text === '' && expr.templateSpans.length === 1) {
    return expr.templateSpans[0].expression.getText();
  }
  return expr.getText();
}

const readsPathname = (expr) => /\.pathname$/.test(expr.getText());

/** Every path a method's body compares against: `===`, `startsWith` and `switch` cases on a `pathname`. */
function comparedPaths(body) {
  const found = [];
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      if (readsPathname(n.left)) found.push(n.right);
      else if (readsPathname(n.right)) found.push(n.left);
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ['startsWith', 'endsWith', 'includes'].includes(n.expression.name.text)
      && readsPathname(n.expression.expression) && n.arguments[0]) {
      found.push(n.arguments[0]);
    }
    if (ts.isSwitchStatement(n) && readsPathname(n.expression)) {
      for (const clause of n.caseBlock.clauses) if (ts.isCaseClause(clause)) found.push(clause.expression);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

function registeredPrefixes(cls) {
  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member) || member.name.getText() !== 'HTTP_PREFIXES') continue;
    if (!member.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) return undefined;
    let init = member.initializer;
    while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression?.(init))) init = init.expression;
    if (init && ts.isArrayLiteralExpression(init)) return new Set(init.elements.map(pathKey));
  }
  return undefined;
}

const envText = readFileSync(join(ROOT, ENV_DECLARATIONS), 'utf8');
const counts = { fetchSites: 0, routeDORequest: 0, surfaces: 0, comparisons: 0, stubs: 0 };

for (const file of sourceFiles()) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const inNebulaAuth = file.startsWith('packages/nebula-auth/src/');

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const fn = enclosingFunction(node);

      // 1. A member `.fetch(` is a named forward, or a binding `Env` says is no Durable Object.
      if (method === 'fetch') {
        counts.fetchSites++;
        const row = NOT_DURABLE_OBJECTS.find((r) => r.file === file && r.fn === fn);
        if (row) {
          const declared = new RegExp(`^\\s*${row.binding}\\??:\\s*(\\S+)`, 'm').exec(envText)?.[1];
          const body = (() => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n.getText(); return ''; })();
          if (!declared) fail(file, node, `\`${row.binding}\` is not in ${ENV_DECLARATIONS}, so this \`.fetch(\` cannot be shown to miss a Durable Object`);
          else if (declared.startsWith('DurableObjectNamespace')) fail(file, node, `\`${row.binding}\` is a Durable Object namespace — a \`.fetch(\` on it belongs in a named forward`);
          else if (!body.includes(`.${row.binding}`)) fail(file, node, `\`${fn}\` no longer reads \`${row.binding}\`, so its \`.fetch(\` is unclassified`);
        } else if (!isNamedForward(file, fn)) {
          fail(file, node, `\`.fetch(\` in \`${fn ?? '(module scope)'}\` is neither a named forward nor a binding classified as no Durable Object`);
        }
      }

      // 4. A Durable Object stub is made only in a named forward, or by nebula-auth for its Registry.
      const makesStub = STUB_MAKERS.has(method)
        || (method === 'get' && node.arguments.some((a) => /\b(idFromName|idFromString|newUniqueId)\(/.test(a.getText())));
      if (makesStub) {
        counts.stubs++;
        const registry = inNebulaAuth && node.expression.expression.getText().includes('NEBULA_AUTH_REGISTRY');
        if (!registry && !isNamedForward(file, fn)) {
          fail(file, node, `a Durable Object stub made in \`${fn ?? '(module scope)'}\` — call a node over the mesh, or a \`@rawRpc()\` method through \`rawRpcStub\``);
        }
      }
    }

    // 2. Every `routeDORequest` call under `apps/` passes `bindings`.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'routeDORequest'
      && file.startsWith('apps/')) {
      counts.routeDORequest++;
      const options = node.arguments[2];
      const has = options && ts.isObjectLiteralExpression(options)
        && options.properties.some((p) => p.name?.getText() === 'bindings');
      if (!has) fail(file, node, '`routeDORequest` without a `bindings` allow-list reaches any Durable Object binding the Worker holds');
    }

    // 3. A mesh node's HTTP surface compares the path only against what its class registers.
    if (ts.isClassDeclaration(node)) {
      const base = node.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression.getText();
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const name = member.name.getText();
        const surface = name === 'onRequest' || (name === 'fetch' && base !== undefined && !NON_MESH_BASES.has(base));
        if (!surface) continue;
        counts.surfaces++;
        const registered = registeredPrefixes(node);
        if (!registered) {
          fail(file, member, `\`${node.name?.text}.${name}\` has no static \`HTTP_PREFIXES\` array to dispatch on`);
          continue;
        }
        for (const operand of comparedPaths(member.body)) {
          counts.comparisons++;
          if (!registered.has(pathKey(operand))) {
            fail(file, operand, `\`${node.name?.text}.${name}\` dispatches on \`${operand.getText()}\`, which \`HTTP_PREFIXES\` does not register`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

console.log(
  `audit:do-http — ${counts.fetchSites} member .fetch( sites, ${counts.routeDORequest} routeDORequest calls under apps/, `
  + `${counts.surfaces} mesh-node HTTP surfaces comparing ${counts.comparisons} paths, ${counts.stubs} stub-making calls`,
);
if (failures.length) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exit(1);
}
console.log('audit:do-http passed');
