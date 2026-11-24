import fs from "node:fs";
const base = process.argv[2];
const key = JSON.parse(fs.readFileSync("results/handles.json")).keys.full;
const ms = `$(( ($(date +%s%N)-S)/1000000 ))ms`;
const stamp = `while IFS= read -r l; do echo "${ms} $l"; done`;
const cmd = [
  "chown 0:0 / 2>/dev/null",
  `S=$(date +%s%N); getent hosts registry.npmjs.org >/dev/null; echo "dns lookup returned $?, ${ms}"`,
  "ls -a ~ ; ls ~/.npm 2>/dev/null | head",
  `S=$(date +%s%N); NODE_DEBUG=net,dns,http,https,tls node node_modules/vite/bin/vite.js build 2>&1 | grep -iE 'connect|lookup|dns|socket|http|tls|built in' | ${stamp} | head -25; echo "process exited at ${ms}"`,
].join("; ");
for (const op of ["r2full", "baked"]) {
  const body = op === "r2full" ? { key, cmd } : { cmd };
  const res = await fetch(`${base}/run/${op}?do=p5-${op}-${crypto.randomUUID().slice(0, 8)}`, { method: "POST", body: JSON.stringify(body) });
  const d = JSON.parse((await res.text()).trim());
  fs.appendFileSync("results/probe5.jsonl", JSON.stringify({ label: `${op}-probe5`, ...d }) + "\n");
  console.log(`===== ${op} probeMs=${d.probeMs} then buildMs=${d.buildMs} ${d.error ?? ""}\n${d.probe}`);
}
