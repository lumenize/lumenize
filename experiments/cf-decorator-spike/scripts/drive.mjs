// Drives the deployed spike: reads the decorator metadata, fires the three mesh calls, and waits
// for their answers. Exits non-zero unless every case comes back as RESULTS.md says it should.
const base = process.env.SPIKE_URL ?? 'https://experiment-cf-decorator-spike.transformation.workers.dev';
const id = crypto.randomUUID();
const get = async (path) => (await fetch(base + path)).json();

const meta = await get('/meta');
console.log('meta', meta);
await get(`/start?id=${id}`);
let results = {};
for (let i = 0; i < 20 && Object.keys(results).length < 3; i++) {
  await new Promise((r) => setTimeout(r, 500));
  results = await get(`/results?id=${id}`);
}
console.log('results', results);
const ok = meta.hello === true && meta.gate === true && meta.secret === false
  && results.method?.value === 'hello, spike'
  && results.getter?.value === 42
  && /not mesh-callable/.test(results.undecorated?.error ?? '');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
