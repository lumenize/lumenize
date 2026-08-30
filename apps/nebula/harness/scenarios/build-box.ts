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
 */
import assert from 'node:assert/strict';
import type { Galaxy } from '@lumenize/nebula';
import type { BuildReport } from '../../src/build-report';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

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

    // ── The dist READBACK through the ungated serve ──
    const star = `${SCOPE}.dev`;
    const page = await fetch(`${stack.baseUrl}/app/${star}/`);
    assert.equal(page.status, 200, `the built app should serve, got ${page.status}`);
    assert.equal(page.headers.get('cache-control'), 'no-store', 'index.html must be no-store');
    const html = await page.text();
    assert.ok(html.includes(`<base href="/app/${star}/">`), 'index.html must carry the injected <base>');
    assert.ok(html.includes('name="nebula-scope"'), 'index.html must carry the server-derived scope meta');
    assert.ok(html.includes(`"activeScope":"${star}"`), 'the scope meta names the star');
    const assetPath = html.match(/(assets\/[^"']+\.js)/)?.[1];
    assert.ok(assetPath, `the built index.html should reference a hashed asset (got: ${html.slice(0, 300)})`);
    const asset = await fetch(`${stack.baseUrl}/app/${star}/${assetPath}`);
    assert.equal(asset.status, 200, `hashed asset should serve, got ${asset.status}`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    // ── A broken source fails the BUNDLE step (their code — never the container step),
    //    publish says why, and last-good dist serves throughout ──
    await client.lmz.callAsync('GALAXY', SCOPE,
      client.ctn<Galaxy>().writeSource('src/App.vue', '<script setup>this is not vue</scr'));
    const bad = await buildNow();
    assert.ok(bad.container.ran && bad.container.ok === true,
      `a compile break must not fail the container step: ${JSON.stringify(bad.container).slice(0, 300)}`);
    assert.ok(!bundleOk(bad) && bundleTail(bad).length > 0,
      `a compile break is a bundle-step failure (their code), got ${JSON.stringify(bad.bundle).slice(0, 300)}`);
    assert.equal(bad.publish.done, false, 'a failed bundle can never publish');
    assert.ok(bad.publish.why.length > 0, 'a non-publish always says why');
    const stillServes = await fetch(`${stack.baseUrl}/app/${star}/`);
    assert.equal(stillServes.status, 200, 'last-good dist/ must keep serving through a failed build');
    await client.lmz.callAsync('GALAXY', SCOPE, client.ctn<Galaxy>().writeSource('src/App.vue',
      '<script setup lang="ts"></script>\n<template><main>fixed</main></template>\n'));
    const fixed = await buildNow();
    assert.ok(bundleOk(fixed), `the fixed source should bundle, got ${JSON.stringify(fixed.bundle)}`);
    assert.equal(fixed.publish.done, true, 'a clean rebuild publishes by default');
  } finally {
    driver.dispose();
  }
}
