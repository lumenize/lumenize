/**
 * The ephemeral build-box drive — the deterministic verification of the container
 * contract, riding the admin-gated `Galaxy.buildNow()` (the model's own `build` tool
 * calls are not deterministically drivable; same latch, same cycle). `buildNow`
 * returns the per-step `BuildReport` (tasks/archive/nebula-move-compilers-out-of-the-worker.md
 * § *What `build` returns*) — there is no global `ok`, so every limb here reads
 * STEPS.
 *
 * ONE contract, BOTH venues — local `wrangler dev` + Docker, and deployed. The venues
 * differ only in transport: deployed, computerd kernel-mounts the Galaxy's VFS at
 * `/workspace` through real FUSE; locally there is no `/dev/fuse`, and computerd
 * materializes the synced tree onto the container's real disk instead. The contract is
 * identical either way, because both serve the VFS's `/workspace` SUBTREE
 * (build-report.ts § WS_ROOT — the 2026-08-29 bisect, `experiments/fuse-bisect`).
 *
 * ⚠️ The old "two worlds" framing — a deterministic local `Cannot resolve entry module`
 * failure treated as the shim venue's expected outcome — was FALSE, an artifact of
 * root-level VFS seeding observed in both venues. That signature now means one thing
 * anywhere it appears: the mount served nothing, which is a REGRESSION this scenario
 * exists to red on (the assertion message carries the failed bundle's tail).
 *
 * The built app also makes the dev Star's host the place a page meets the Worker's tracks, so the
 * readback carries those limbs too: a page load of `/api` gets the app's page and never the build
 * box's backend, an upgrade is refused by the page helper, a planted instance-name header names no
 * Galaxy, and `/auth/` is the Worker's 404 on every host but the platform's. *Each reds if its
 * defence goes: the helper forwarding the page's own path, dropping its `Upgrade` refusal, copying
 * the client's headers, or `/auth/*` dispatched by path on every host.*
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { Galaxy } from '@lumenize/nebula';
import type { BuildReport } from '../../src/build-report';
import type { DevStack } from '../lib/harness';
import { connectDriver, scopeUrlOf } from '../lib/harness';

/** The build box is the whole subject. */
export const needsContainer = true;

// Per-run unique: a deployed target's state is durable (deploy-test.sh's model is
// fresh scopes per run), a second run at a fixed scope dies at the already-claimed
// universe, and the ontology limb needs a FRESH Galaxy — cycle 1 must find the seed
// ontology pending.
const SCOPE = `claude-${crypto.randomUUID().slice(0, 8)}.buildbox`;
/** A container cold start + the build job fits well inside this; a hang reds the scenario. */
const BUILD_CALL_TIMEOUT_MS = 240_000;

const bundleOk = (r: BuildReport): boolean => r.bundle.ran && r.bundle.ok === true;
const bundleTail = (r: BuildReport): string =>
  r.bundle.ran && r.bundle.ok === false ? r.bundle.tail : '';

function assertCycleReport(tag: string, report: BuildReport): void {
  // The JOB itself must have run — a container-step failure here is the wedge/infra
  // class the lifecycle limbs exist to catch.
  assert.ok(report.container.ran && report.container.ok === true,
    `${tag}: the container step must be ok, got ${JSON.stringify(report.container).slice(0, 300)}`);
  assert.ok(bundleOk(report),
    `${tag}: expected a clean bundle, got ${JSON.stringify(report.bundle).slice(0, 400)}`);
  // Printed, not asserted: the preview verdict says whether the dist ARRIVED host-side
  // (`refreshed: false` with a did-not-arrive `why` after a clean bundle is the local
  // materialize-mode pull miss), which the 404 at the end of the run cannot say alone.
  console.log(`[build-box] ${tag}: preview=${JSON.stringify(report.preview)}`);
}

export async function run(stack: DevStack): Promise<void> {
  console.log(`[build-box] scope: ${SCOPE}`); // durable state on a deployed target — printed so a later check can find it
  const driver = await connectDriver(stack, { scope: SCOPE, connectTimeoutMs: 60_000 });
  const { client } = driver;
  const buildNow = () =>
    client.lmz.callAsync(
      'GALAXY', SCOPE, client.ctn<Galaxy>().buildNow(),
      { timeoutMs: BUILD_CALL_TIMEOUT_MS },
    ) as Promise<BuildReport>;

  try {
    // ── LIMB 1: the first cycle runs the full job against a fresh Galaxy ──
    const b1 = await buildNow();
    assert.ok(b1.container.ran && b1.container.ok === true,
      `build 1's container step must be ok: ${JSON.stringify(b1.container).slice(0, 400)}`);
    if (!bundleOk(b1)) {
      // Print the job's own diagnostics before failing — a mount-serves-nothing
      // regression rides the bundle tail, and the full report explains itself.
      console.log(`[build-box] bundle tail: ${bundleTail(b1).slice(0, 600)}`);
      console.log(`[build-box] full report: ${JSON.stringify(b1).slice(0, 1500)}`);
      throw new assert.AssertionError({
        message: `build 1's bundle failed — if the tail says 'Cannot resolve entry module', ` +
          `the mount served nothing (the WS_ROOT contract in build-report.ts): ${bundleTail(b1).slice(0, 300)}`,
      });
    }

    // ── LIMB 2: a SECOND sequential cycle on the SAME Galaxy instance — catches the
    //           missing-monitor wedge (`.running` stale-true → the second start throws,
    //           which would surface as a container-step failure).
    assertCycleReport('build 2 (sequential)', await buildNow());

    // ── LIMB 3: two OVERLAPPING cycles both settle correctly (the promise-chain latch
    //           queues them; neither a start() throw nor a sibling's destroy kills one).
    const [o1, o2] = await Promise.all([buildNow(), buildNow()]);
    assertCycleReport('overlap A', o1);
    assertCycleReport('overlap B', o2);

    // ── The job's own steps against the served mount ──
    // The first cycle on this fresh Galaxy carried the seed ontology (not yet in the
    // registry), so the ontology step ran and wrote the row into the mount; typeCheck
    // names what tsc actually looked at.
    assert.ok(b1.typeCheck.ran, 'typeCheck must run');
    assert.ok(b1.typeCheck.checked.includes('src/App.vue'),
      `typeCheck.checked should name the seed SFC, got ${JSON.stringify(b1.typeCheck.checked)}`);
    assert.ok(b1.ontology.ran && b1.ontology.ok === true && b1.ontology.rowPath,
      `the fresh Galaxy's pending seed ontology should compile in cycle 1, got ${JSON.stringify(b1.ontology)}`);
    // The Galaxy reads the row back host-side — prove it is THERE and parseable…
    const rowJson = await client.lmz.callAsync('GALAXY', SCOPE,
      client.ctn<Galaxy>().readSource(b1.ontology.rowPath!)) as string;
    const row = JSON.parse(rowJson) as { version: string; validatorBundle: string };
    assert.ok(row.version.length > 0 && row.validatorBundle.length > 0,
      'the mount-side row must carry version + validatorBundle');
    // …and UNTRACKED: git's index stores tracked paths as plain bytes, so the row's
    // filename must be absent while a genuinely committed path is present (the
    // positive control that proves this read can find a tracked file at all).
    const gitIndex = await client.lmz.callAsync('GALAXY', SCOPE,
      client.ctn<Galaxy>().readSource('.git/index')) as string;
    assert.ok(gitIndex.includes('src/App.vue'), 'positive control: the git index must list the committed seed SFC');
    assert.ok(!gitIndex.includes('ontology-row.json'),
      'the compiled row must stay UNTRACKED — git tracks only what git.add is handed');

    // ── The dist READBACK through the ungated serve, on the dev Star's own host ──
    const star = `${SCOPE}.dev`;
    const starPage = scopeUrlOf(stack, star);
    const page = await fetch(`${starPage}/`);
    assert.equal(page.status, 200, `the built app should serve, got ${page.status}`);
    assert.equal(page.headers.get('cache-control'), 'no-store', 'index.html must be no-store');
    assert.equal(page.headers.get('content-security-policy'), `frame-ancestors ${scopeUrlOf(stack, SCOPE)}`,
      "the dev Star's page may be framed by its galaxy's Studio alone");
    const html = await page.text();
    assert.ok(html.includes('name="nebula-scope"'), 'index.html must carry the server-derived scope meta');
    assert.ok(html.includes('"dev":true'), 'the scope meta marks the dev Star');
    assert.ok(html.includes(`"parentOrigin":"${scopeUrlOf(stack, SCOPE)}"`), "the scope meta names the galaxy's Studio");
    assert.ok(html.includes('name="lumenize-origin"'), 'index.html must carry the deployment origin meta');
    const assetPath = html.match(/(assets\/[^"']+\.js)/)?.[1];
    assert.ok(assetPath, `the built index.html should reference a hashed asset (got: ${html.slice(0, 300)})`);
    const asset = await fetch(`${starPage}/${assetPath}`);
    assert.equal(asset.status, 200, `hashed asset should serve, got ${asset.status}`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    // ── A page reaches nothing but the Galaxy's `/_public/` — each defence by the answer it gives ──
    // (a) `/api` is the build box's own dial-back path on the Galaxy; a page load of it gets the
    //     built app's page, never the backend's 400 to a request that is not an upgrade.
    const apiPage = await fetch(`${starPage}/api`, { headers: { Accept: 'text/html' } });
    assert.equal(apiPage.status, 200, `a page load of /api must get the app's page, got ${apiPage.status}`);
    assert.ok((await apiPage.text()).includes('name="nebula-scope"'), "a page load of /api must be the built app's page");
    // (b) An upgrade to `/api` is refused by the page helper itself. Node's fetch refuses an
    //     `Upgrade` header, so the request is a raw one.
    const upgrade = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(`${starPage}/api`, {
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode ?? 101, body: '' }); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(upgrade.status, 426, `an upgrade to /api must be refused, got ${upgrade.status}`);
    assert.match(upgrade.body, /A page request is never upgraded/, "the refusal must be the page helper's own");
    // (c) A page load planting the instance-name header on a galaxy NEVER created — the load is
    //     that Galaxy's first contact — is not a name-mismatch 500, and leaves it named for itself:
    //     a second, plain load is no 500 either.
    const neverMade = scopeUrlOf(stack, `${SCOPE.split('.')[0]}.nevermade.dev`);
    const planted = await fetch(`${neverMade}/`, { headers: { 'x-lumenize-do-instance-name-or-id': 'evil.x' } });
    assert.notEqual(planted.status, 500, 'a planted instance name must not reach the Galaxy as its identity');
    await planted.text();
    const plain = await fetch(`${neverMade}/`);
    assert.notEqual(plain.status, 500, 'the Galaxy must stay named for itself after a planted first contact');
    await plain.text();

    // ── `/auth/` answers only on the platform host ──────────────────────────────────────────────
    // The dev Star's host has a built app, whose single-page fallback would answer 200 for any
    // path, so a 404 here is the Worker's own refusal.
    for (const host of [starPage, scopeUrlOf(stack, SCOPE.split('.')[0])]) {
      const claim = await fetch(`${host}/auth/claim-universe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(claim.status, 404, `POST /auth/claim-universe on ${host} must be the Worker's 404`);
      const login = await fetch(`${host}/auth/login`, { headers: { Accept: 'text/html' } });
      assert.equal(login.status, 404, `GET /auth/login on ${host} must be the Worker's 404`);
    }
    // Positive control: on the platform host the same POST reaches the route, which refuses the
    // empty body rather than answering 404.
    const onPlatform = await fetch(`${stack.baseUrl}/auth/claim-universe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.notEqual(onPlatform.status, 404, 'the same POST on the platform host must reach the claim route');
    await onPlatform.text();

    // ── A broken source fails the BUNDLE step (their code — never the container step),
    //    preview says why it did not refresh, and last-good dist serves throughout ──
    await client.lmz.callAsync('GALAXY', SCOPE,
      client.ctn<Galaxy>().writeSource('src/App.vue', '<script setup>this is not vue</scr'));
    const bad = await buildNow();
    assert.ok(bad.container.ran && bad.container.ok === true,
      `a compile break must not fail the container step: ${JSON.stringify(bad.container).slice(0, 300)}`);
    assert.ok(!bundleOk(bad) && bundleTail(bad).length > 0,
      `a compile break is a bundle-step failure (their code), got ${JSON.stringify(bad.bundle).slice(0, 300)}`);
    assert.equal(bad.preview.refreshed, false, 'a failed bundle can never refresh the preview');
    assert.ok(bad.preview.why.length > 0, 'a preview that did not refresh always says why');
    const stillServes = await fetch(`${starPage}/`);
    assert.equal(stillServes.status, 200, 'last-good dist/ must keep serving through a failed build');
    await client.lmz.callAsync('GALAXY', SCOPE, client.ctn<Galaxy>().writeSource('src/App.vue',
      '<script setup lang="ts"></script>\n<template><main>fixed</main></template>\n'));
    const fixed = await buildNow();
    assert.ok(bundleOk(fixed), `the fixed source should bundle, got ${JSON.stringify(fixed.bundle)}`);
    // The report always says WHY it did not refresh (asserted above), so put it in the message —
    // `false !== true` alone cost a full 110 s re-run just to learn which gate refused.
    assert.equal(fixed.preview.refreshed, true,
      `a clean rebuild refreshes the preview by default — refused because: ${fixed.preview.why} ` +
      `(bundle=${JSON.stringify(fixed.bundle).slice(0, 200)}; typeCheck=${JSON.stringify(fixed.typeCheck).slice(0, 200)})`);
  } finally {
    driver.dispose();
  }
}
