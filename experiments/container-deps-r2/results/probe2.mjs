import fs from "node:fs";
const base = process.argv[2];
const P2 = [
  "chown 0:0 / 2>/dev/null",
  "echo '-- @swc:'; du -sm node_modules/@swc/* 2>/dev/null",
  "echo '-- @swc/core top-level:'; ls -la node_modules/@swc/core | grep -v '^total' | awk '{print $5, $9}' | head -30",
  "echo '-- biggest packages:'; du -sm node_modules/* node_modules/@*/* 2>/dev/null | sort -n | tail -8",
  `node -e "const t=Date.now(); const s=require('@swc/core'); const t1=Date.now(); s.transformSync('const a: number = 1', {jsc:{parser:{syntax:'typescript'}}}); console.log('swc require', t1-t, 'ms; first transform', Date.now()-t1, 'ms')" 2>&1 | tail -3`,
  "echo '-- ~/.cache after:'; ls ~/.cache",
].join("; ");
for (const [op, body, label] of [["r2full", { key: JSON.parse(fs.readFileSync("results/handles.json")).keys.full, cmd: P2 }, "r2-full-probe2"], ["baked", { cmd: P2 }, "baked-probe2"]]) {
  const res = await fetch(`${base}/run/${op}?do=${label}-${crypto.randomUUID().slice(0, 8)}`, { method: "POST", body: JSON.stringify(body) });
  const d = JSON.parse((await res.text()).trim());
  fs.appendFileSync("results/probe2.jsonl", JSON.stringify({ label, ...d }) + "\n");
  console.log(`===== ${label} buildMs=${d.buildMs} ${d.error ?? ""}\n${d.probe}`);
}
