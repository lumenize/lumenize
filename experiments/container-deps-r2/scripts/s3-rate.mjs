// How fast is the s3fs copy going? Counts the S3Shim's requests by method in one-minute windows.
import fs from "node:fs";
const vars = Object.fromEntries(fs.readFileSync(new URL("../../../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const [fromIso, minutes = "1"] = process.argv.slice(2);
for (let i = 0; i < Number(minutes); i++) {
  const from = Date.parse(fromIso) + i * 60_000, to = from + 60_000;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${vars.CLOUDFLARE_ACCOUNT_ID}/workers/observability/telemetry/query`, {
    method: "POST", headers: { Authorization: `Bearer ${vars.CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ queryId: "rate-" + crypto.randomUUID(), view: "events", limit: 2000, timeframe: { from, to },
      parameters: { filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "experiment-container-deps-r2" }] } }),
  });
  const ev = (await res.json()).result?.events?.events ?? [];
  const by = {};
  for (const e of ev) { const m = (e.$metadata?.message || "").split(" ")[0]; by[m] = (by[m] || 0) + 1; }
  console.log(new Date(from).toISOString().slice(11, 16), ev.length === 2000 ? "≥2000 (page full)" : ev.length, JSON.stringify(by));
}
