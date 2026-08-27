// Drive the deployed probe: fire the HELD and CONTROL arms on SEPARATE fresh instances,
// go silent for the whole window, then read both statuses. The silence is the point —
// any mid-window poll of the SAME DO would reset its idle clock and rescue the control.
//
//   node scripts/drive.mjs [ms]     (default 240000 — 4 min, past the ~10s fast clock
//                                    and into the disputed minutes-scale window)
const BASE = process.env.PROBE_URL ?? 'https://experiment-residency-hold.transformation.workers.dev';
const ms = Number(process.argv[2] ?? 240_000);
const runId = Date.now().toString(36);

const arms = [
  { arm: 'held', instance: `held-${runId}` },
  { arm: 'control', instance: `control-${runId}` },
];

for (const { arm, instance } of arms) {
  const res = await fetch(`${BASE}/fire?instance=${instance}&arm=${arm}&ms=${ms}`);
  console.log(`fired ${arm} on ${instance}:`, await res.text());
}

const waitMs = ms + 45_000;
console.log(`silent for ${Math.round(waitMs / 1000)}s (the window + margin)…`);
await new Promise((r) => setTimeout(r, waitMs));

for (const { arm, instance } of arms) {
  const res = await fetch(`${BASE}/status?instance=${instance}`);
  const s = await res.json();
  const start = s[`${arm}Start`];
  const finish = s[`${arm}Finish`];
  const survived = !!finish && finish.bootId === start?.bootId;
  console.log(`\n${arm} (${instance}): ${survived ? 'SURVIVED — detached await completed in the SAME isolate' : finish ? 'finished but in a DIFFERENT isolate (unexpected)' : 'EVICTED — the detached await never completed'}`);
  console.log(JSON.stringify(s, null, 2));
}
