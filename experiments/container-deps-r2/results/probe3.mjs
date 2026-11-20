import fs from "node:fs";
const base = process.argv[2];
const key = JSON.parse(fs.readFileSync("results/handles.json")).keys.full;
const runs = [
  ["no-wasm", "rm -rf node_modules/@swc/wasm && echo removed"],
  ["after-build-files", "echo none"],
];
for (const [label, cmd] of runs) {
  const res = await fetch(`${base}/run/r2full?do=p3-${label}-${crypto.randomUUID().slice(0, 8)}`, { method: "POST", body: JSON.stringify({ key, cmd, diag: label === "after-build-files" }) });
  const d = JSON.parse((await res.text()).trim());
  fs.appendFileSync("results/probe3.jsonl", JSON.stringify({ label, ...d }) + "\n");
  console.log(`===== ${label} fetchExtractMs=${d.fetchExtractMs} buildMs=${d.buildMs} build2Ms=${d.build2Ms ?? "-"} ${d.error ?? ""} probe=${d.probe}`);
}
