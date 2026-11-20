// How does a DNS lookup behave in a build box started with `enableInternet: false`, and what
// makes it fail fast without breaking an intercepted host (`deps.r2`, the archive's)?
//
//   node scripts/dns-probe.mjs <base-url>
//
// Runs two ops on the deployed Worker's `baked` image through `/start` and `/result`, each
// passing a shell command the op runs before its build. Output from 2026-11-20 is in
// results/dns-probe-2026-11-20.txt.
const base = process.argv[2];
if (!base) throw new Error("usage: node scripts/dns-probe.mjs <base-url>");

const ms = `$(( ($(date +%s%N)-S)/1000000 ))ms`;
const t = (label, cmd) => `S=$(date +%s%N); ${cmd} >/dev/null 2>&1; echo "${label}: exit=$? ${ms}"`;
const nodeLookup = (host) => `node -e "require('dns').lookup('${host}', (e) => console.log(e ? e.code : 'resolved'))"`;

// The resolver as the platform sets it, then RES_OPTIONS alone, which changes no file.
const asShipped = [
  "echo '-- /etc/resolv.conf:'; grep -v '^#' /etc/resolv.conf",
  t("getent, default", "getent hosts registry.npmjs.org"),
  t("getent, RES_OPTIONS timeout:1 attempts:1", "RES_OPTIONS='timeout:1 attempts:1' getent hosts registry.npmjs.org"),
  `S=$(date +%s%N); r=$(RES_OPTIONS='timeout:1 attempts:1' ${nodeLookup("registry.npmjs.org")}); echo "node dns.lookup, RES_OPTIONS: $r ${ms}"`,
  t("intercepted host deps.r2, RES_OPTIONS (curl)", "RES_OPTIONS='timeout:1 attempts:1' curl -sS --fail --max-time 10 http://deps.r2/__where"),
  t("intercepted host deps.r2, default (curl)", "curl -sS --fail --max-time 10 http://deps.r2/__where"),
].join("; ");

// Rewriting /etc/resolv.conf: one of its own servers with a 1 s timeout, then localhost only.
const rewritten = [
  "ls -l /etc/resolv.conf; grep -E ' /etc/resolv.conf ' /proc/mounts || echo 'not a mount'",
  "cp /etc/resolv.conf /tmp/resolv.orig",
  "printf 'nameserver 1.1.1.1\\noptions timeout:1 attempts:1\\n' > /etc/resolv.conf && echo 'wrote: one server, timeout 1' || echo 'write refused'",
  t("getent, one server + timeout:1", "getent hosts registry.npmjs.org"),
  t("deps.r2 after rewrite (curl)", "curl -sS --fail --max-time 10 http://deps.r2/__where"),
  "printf 'nameserver 127.0.0.1\\n' > /etc/resolv.conf && echo 'wrote: localhost only'",
  t("getent, localhost resolver", "getent hosts registry.npmjs.org"),
  `S=$(date +%s%N); r=$(${nodeLookup("registry.npmjs.org")}); echo "node dns.lookup, localhost resolver: $r ${ms}"`,
  t("deps.r2 with localhost resolver (curl)", "curl -sS --fail --max-time 10 http://deps.r2/__where"),
  "cp /tmp/resolv.orig /etc/resolv.conf",
].join("; ");

async function probe(label, cmd) {
  const name = `dnsprobe-${crypto.randomUUID().slice(0, 8)}`;
  const s = await (await fetch(`${base}/start/baked?do=${name}`, { method: "POST", body: JSON.stringify({ cmd }) })).json();
  if (!s.started) throw new Error(JSON.stringify(s));
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 5_000));
    const r = await fetch(`${base}/result?do=${name}`).then((x) => x.json()).catch(() => ({ status: "poll-failed" }));
    if (r.status === "done") {
      console.log(`== ${label}  probeMs=${r.probeMs} buildMs=${r.buildMs} error=${r.error ?? "none"}\n${r.probe}\n`);
      return;
    }
  }
}

await probe("as shipped", asShipped);
await probe("rewritten", rewritten);
