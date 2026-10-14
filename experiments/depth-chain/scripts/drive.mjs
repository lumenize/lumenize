// Drives the probe: measures the limit with /pingpong, then runs each mode with a real WebSocket
// client that answers every frame at once, and prints how far each got.
const BASE = process.env.BASE ?? 'https://experiment-depth-chain.transformation.workers.dev';
const ROUNDS = Number(process.env.ROUNDS ?? 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('pingpong:', await (await fetch(`${BASE}/pingpong`)).text());

for (const mode of ['held', 'fresh']) {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let answered = 0;
  ws.onmessage = (e) => { answered++; ws.send(e.data); };
  await fetch(`${BASE}/run?mode=${mode}&rounds=${ROUNDS}`);
  let last;
  for (let i = 0; i < 60; i++) {
    await sleep(1_000);
    last = await (await fetch(`${BASE}/result`)).json();
    if (last?.host || last?.node?.error || last?.node?.round >= ROUNDS) break;
  }
  console.log(`${mode}: client answered ${answered} frame(s); result ${JSON.stringify(last)}`);
  ws.close();
  await sleep(1_000);
}
