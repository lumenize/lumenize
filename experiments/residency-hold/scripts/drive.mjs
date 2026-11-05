// Drive the deployed probe: fire EVERY arm on its own fresh instance, on BOTH deployments
// (the flag's default date vs Nebula's current date), go silent for the whole window, then
// read every status. The silence is the point — any mid-window poll of the SAME DO would
// reset its idle clock and rescue an arm that should have been evicted.
//
//   node scripts/drive.mjs          full run: ms=240000 (past the 70–140 s eviction window)
//   node scripts/drive.mjs smoke    plumbing check: ms=3000, tiny AI call, short wait
//   node scripts/drive.mjs timers   timer arms only, 5 instances each, flag date only
const DEPLOYMENTS = [
  { date: '2026-10-01', base: 'https://experiment-residency-hold.transformation.workers.dev' },
  { date: '2026-08-15', base: 'https://experiment-residency-hold-pre.transformation.workers.dev' },
];
const ALL_ARMS = ['control', 'held', 'waitUntil', 'binding', 'fetch', 'fetchStream', 'ai'];
const smoke = process.argv[2] === 'smoke';
const timers = process.argv[2] === 'timers';
const ARMS = timers ? ['control', 'held'] : ALL_ARMS;
const REPS = timers ? 5 : 1;
const deployments = timers ? DEPLOYMENTS.filter((d) => d.date === '2026-10-01') : DEPLOYMENTS;
const ms = smoke ? 3_000 : 240_000;
const aiMaxTokens = smoke ? 64 : 16_000;
const waitMs = smoke ? 60_000 : ms + 45_000;
const runId = Date.now().toString(36);

const runs = [];
for (const { date, base } of deployments) {
  for (const arm of ARMS) for (let rep = 0; rep < REPS; rep++) {
    const instance = `${arm}-${runId}${REPS > 1 ? `-${rep}` : ''}`;
    const res = await fetch(`${base}/fire?instance=${instance}&arm=${arm}&ms=${ms}&aiMaxTokens=${aiMaxTokens}`);
    const body = await res.text();
    console.log(`${new Date().toISOString()} fired ${date} ${arm} on ${instance}: ${res.status} ${body}`);
    runs.push({ date, base, arm, instance });
  }
}

console.log(`silent for ${Math.round(waitMs / 1000)}s…`);
await new Promise((r) => setTimeout(r, waitMs));

const rows = [];
for (const { date, base, arm, instance } of runs) {
  const res = await fetch(`${base}/status?instance=${instance}`);
  const s = await res.json();
  let verdict;
  if (s.error) verdict = `ERROR — ${s.error.detail?.message}`;
  else if (s.finish && s.finish.bootId === s.start?.bootId) verdict = 'HELD — completed in the same isolate';
  else if (s.finish) verdict = 'finished in a DIFFERENT isolate (unexpected)';
  else if (s.currentBootId === s.start?.bootId) verdict = 'STILL RUNNING in the same isolate (held so far)';
  else verdict = 'EVICTED — the detached await never completed';
  if (arm === 'ai' && s.finish?.detail?.aiMs !== undefined && s.finish.detail.aiMs < 150_000 && !smoke) {
    verdict += ` — INCONCLUSIVE: the call took ${Math.round(s.finish.detail.aiMs / 1000)} s, inside the eviction window`;
  }
  rows.push({ date, arm, verdict });
  console.log(`\n[${date}] ${arm} (${instance}): ${verdict}`);
  console.log(JSON.stringify(s, null, 2));
}

console.log('\n=== summary ===');
for (const { date, arm, verdict } of rows) console.log(`${date}  ${arm.padEnd(12)} ${verdict}`);
