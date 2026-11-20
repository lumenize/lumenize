// What did the experiment's containers transmit? containersUsageAdaptiveGroups.txBytes is the figure
// Cloudflare says to use for billing estimates; compare it with what we know went out through the
// intercept. Tries each analytics-capable token in .dev.vars until one is allowed; prints no secret.
import fs from "node:fs";
const vars = Object.fromEntries(fs.readFileSync(new URL("../../../.dev.vars", import.meta.url), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
const [query, variables] = [process.argv[2], JSON.parse(process.argv[3] ?? "{}")];
for (const name of ["CLOUDFLARE_NOTIFICATIONS_AND_OBSERVABILITY_TOKEN", "CLOUDFLARE_LOG_QUERY_TOKEN", "CLOUDFLARE_WORKERS_READ_TOKEN"]) {
  if (!vars[name]) continue;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST", headers: { Authorization: `Bearer ${vars[name]}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { accountTag: vars.CLOUDFLARE_ACCOUNT_ID, ...variables } }),
  });
  const body = await res.json();
  if (body.errors?.length && /auth|permission|not authorized/i.test(JSON.stringify(body.errors))) { console.error(`${name}: not allowed`); continue; }
  console.log(`[${name}]`, JSON.stringify(body.data ?? body.errors, null, 1).slice(0, 6000));
  break;
}
