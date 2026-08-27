/**
 * The ephemeral build-box drive — the deterministic verification of the Phase-3
 * container contract, riding the admin-gated `Galaxy.buildNow()` (the model's own
 * `build` tool calls are not deterministically drivable; same latch, same cycle).
 *
 * ⚠️ TWO WORLDS, detected at run time from build 1's outcome:
 *
 *  - **Deployed (real FUSE)**: `/dev/fuse` exists, computerd kernel-mounts the Galaxy's
 *    VFS at `/workspace`, and the FULL contract runs — build ok, dist READBACK through
 *    the ungated serve (`<base>` + `nebula-scope` + caching pin), sequential + overlap +
 *    buildError-vs-retryable + last-good-serves.
 *
 *  - **Local (`wrangler dev` + Docker)**: no `/dev/fuse`, so computerd degrades to its
 *    userspace store — the pushed bytes are in computerd's OWN object store, and a real
 *    process (vite) sees an EMPTY `/workspace`. That is structural, not a bug to fix
 *    locally (verified 2026-08-28: the exec's push bracket ran, `mount` showed no
 *    workspace mount, `ls /workspace` was empty while the DO-side VFS held all 9
 *    scaffold files). The build then fails DETERMINISTICALLY with vite's
 *    `Cannot resolve entry module index.html` at exit 1 — which this scenario uses as
 *    the local DRIVE contract: a full container cycle completes (boot → exec → exit-1
 *    classified as buildError, never a hang, never retryable), a SECOND cycle on the
 *    same Galaxy works (the missing-`monitor()` wedge shape), and two OVERLAPPING
 *    cycles both settle (the promise-chain latch). The mount-dependent limbs are
 *    logged as DEPLOY-ONLY and skipped.
 */
import assert from 'node:assert/strict';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack } from '../lib/harness';
import { connectDriver } from '../lib/harness';

/** The build box is the whole subject. */
export const needsContainer = true;

const SCOPE = 'claude.buildbox';
/** A container cold start + vite build fits well inside this; a hang reds the scenario. */
const BUILD_CALL_TIMEOUT_MS = 240_000;

type BuildOutcome =
  | { ok: true }
  | { ok: false; buildError: string }
  | { ok: false; retryable: true; detail: string };

const SHIM_SIGNATURE = 'Cannot resolve entry module';

function assertCycleOutcome(tag: string, outcome: BuildOutcome, world: 'fuse' | 'shim'): void {
  if (world === 'fuse') {
    assert.deepEqual(outcome, { ok: true }, `${tag}: expected ok on the mounted world, got ${JSON.stringify(outcome).slice(0, 300)}`);
  } else {
    // The shim world's deterministic outcome: the command RAN and exited 1 — a
    // buildError, never a retryable and never a hang. This is exactly the
    // classification limb: a retryable here means the drive mislabeled a completed
    // non-zero exec as an infra failure.
    assert.equal(outcome.ok, false, `${tag}: the shim world cannot build ok`);
    assert.ok('buildError' in outcome, `${tag}: an exited non-zero build must be buildError (their code), got ${JSON.stringify(outcome).slice(0, 300)}`);
    assert.ok(outcome.buildError.includes(SHIM_SIGNATURE), `${tag}: unexpected build failure: ${outcome.buildError.slice(0, 300)}`);
  }
}

export async function run(stack: DevStack): Promise<void> {
  const driver = await connectDriver(stack, { scope: SCOPE, connectTimeoutMs: 60_000 });
  const { client } = driver;
  const buildNow = () =>
    client.lmz.callAsync(
      'GALAXY', SCOPE, client.ctn<Galaxy>().buildNow(),
      { timeoutMs: BUILD_CALL_TIMEOUT_MS },
    ) as Promise<BuildOutcome>;

  try {
    // ── LIMB 1: the first cycle decides which world we are in ──
    const b1 = await buildNow();
    const world: 'fuse' | 'shim' =
      b1.ok ? 'fuse'
        : ('buildError' in b1 && b1.buildError.includes(SHIM_SIGNATURE)) ? 'shim'
          : (() => { throw new assert.AssertionError({ message: `build 1 is neither the mounted-ok nor the shim signature: ${JSON.stringify(b1).slice(0, 400)}` }); })();
    console.log(`[build-box] world: ${world}${world === 'shim' ? ' — mount-dependent limbs are DEPLOY-ONLY and skipped' : ''}`);

    // ── LIMB 2: a SECOND sequential cycle on the SAME Galaxy instance — catches the
    //           missing-monitor wedge (`.running` stale-true → the second start throws).
    assertCycleOutcome('build 2 (sequential)', await buildNow(), world);

    // ── LIMB 3: two OVERLAPPING cycles both settle correctly (the promise-chain latch
    //           queues them; neither a start() throw nor a sibling's destroy kills one).
    const [o1, o2] = await Promise.all([buildNow(), buildNow()]);
    assertCycleOutcome('overlap A', o1, world);
    assertCycleOutcome('overlap B', o2, world);

    if (world === 'shim') return; // everything below needs the kernel mount — deployed only

    // ── DEPLOYED-ONLY: the dist READBACK through the ungated serve ──
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

    // ── DEPLOYED-ONLY: buildError is THEIR code, and last-good dist serves throughout ──
    await client.lmz.callAsync('GALAXY', SCOPE,
      client.ctn<Galaxy>().writeSource('src/App.vue', '<script setup>this is not vue</scr'));
    const bad = await buildNow();
    assert.equal(bad.ok, false, 'a broken source must not build ok');
    assert.ok('buildError' in bad && bad.buildError.length > 0,
      `a compile break is a buildError (their code), got ${JSON.stringify(bad).slice(0, 300)}`);
    const stillServes = await fetch(`${stack.baseUrl}/app/${star}/`);
    assert.equal(stillServes.status, 200, 'last-good dist/ must keep serving through a failed build');
    await client.lmz.callAsync('GALAXY', SCOPE, client.ctn<Galaxy>().writeSource('src/App.vue',
      '<script setup lang="ts"></script>\n<template><main>fixed</main></template>\n'));
    const fixed = await buildNow();
    assert.deepEqual(fixed, { ok: true }, `the fixed source should build, got ${JSON.stringify(fixed)}`);
  } finally {
    driver.dispose();
  }
}
