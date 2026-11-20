import fs from "node:fs";
const base = process.argv[2];
const key = JSON.parse(fs.readFileSync("results/handles.json")).keys.full;
const stamp = `while IFS= read -r l; do echo "$(( ($(date +%s%N)-S)/1000000 ))ms $l"; done`;
const cmd = [
  "chown 0:0 / 2>/dev/null",
  "ls -la node_modules/.bin/vite",
  "S=$(date +%s%N)",
  `node node_modules/vite/bin/vite.js build 2>&1 | ${stamp} | tail -12`,
  "echo '-- npx after a direct build:'; S=$(date +%s%N); rm -rf dist",
  `npx vite build 2>&1 | ${stamp} | tail -3`,
].join("; ");
for (const op of ["r2full", "baked"]) {
  const body = op === "r2full" ? { key, cmd } : { cmd };
  const res = await fetch(`${base}/run/${op}?do=p4-${op}-${crypto.randomUUID().slice(0, 8)}`, { method: "POST", body: JSON.stringify(body) });
  const d = JSON.parse((await res.text()).trim());
  fs.appendFileSync("results/probe4.jsonl", JSON.stringify({ label: `${op}-probe4`, ...d }) + "\n");
  console.log(`===== ${op} probeMs=${d.probeMs} then buildMs=${d.buildMs} ${d.error ?? ""}\n${d.probe}`);
}
