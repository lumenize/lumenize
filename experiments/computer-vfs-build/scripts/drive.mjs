// Driver: hits the deployed spike N times, each with a FRESH instance name so every run gets
// fresh first-touch container placement (placement does not follow the caller — see
// container-cold-start-probe § 1). Prints one row per rep plus the aggregate ratio.
//
//   node scripts/drive.mjs [runs] [repsPerRun]
//
// Also serves as the external observer the clock-traps guidance asks for: `observedTotalMs`
// comes from here (real wall clock, outside the CF runtime) and should bracket the sum of the
// DO-side step marks.

const BASE = process.env.SPIKE_URL ?? "https://experiment-computer-vfs-build.lumenize.workers.dev";
const runs = Number(process.argv[2] ?? 3);
const reps = Number(process.argv[3] ?? 2);

const all = [];

for (let i = 1; i <= runs; i++) {
  const url = `${BASE}/bench?reps=${reps}&instance=run-${Date.now()}-${i}`;
  const started = Date.now();
  let body;
  try {
    const res = await fetch(url);
    body = await res.json();
    if (!res.ok) {
      console.error(`run ${i}: HTTP ${res.status}`, JSON.stringify(body).slice(0, 800));
      continue;
    }
  } catch (error) {
    console.error(`run ${i}: ${error.message}`);
    continue;
  }
  const driverMs = Date.now() - started;

  console.log(`\n=== run ${i}  colo=${body.colo}  driver=${(driverMs / 1000).toFixed(1)}s  worker=${(body.observedTotalMs / 1000).toFixed(1)}s`);
  console.log(`    mount: ${body.mount}`);
  const s = body.summary;
  console.log(`    cold start + mount: ${s.coldStartAndMountMs} ms   seed write into VFS: ${s.writeSeedIntoVfsMs} ms`);
  for (const p of s.pairs) {
    console.log(
      `    rep ${p.rep}: fuse ${String(p.fuseBuildMs).padStart(6)} ms   disk ${String(p.diskBuildMs).padStart(6)} ms   ratio ${p.ratio}x   dist readback ${p.distReadbackMs} ms`,
    );
    all.push(p);
  }
  const failed = body.steps.filter((x) => x.exitCode !== undefined && x.exitCode !== 0);
  for (const f of failed) console.log(`    !! ${f.name} exit=${f.exitCode} ${f.note ?? ""}`);
  console.log(`    sync accounting: ${body.steps.filter((x) => x.pulled).map((x) => `${x.name} pulled=${x.pulled} pushed=${x.pushed}`).join("  ")}`);
}

if (all.length) {
  const ratios = all.map((p) => p.ratio).sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  console.log(`\n--- ${all.length} pairs | ratio min ${ratios[0]}x  median ${med}x  max ${ratios.at(-1)}x`);
  console.log(`--- fuse builds: ${all.map((p) => p.fuseBuildMs).join(", ")}`);
  console.log(`--- disk builds: ${all.map((p) => p.diskBuildMs).join(", ")}`);
}
