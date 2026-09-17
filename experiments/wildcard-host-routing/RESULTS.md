# Wildcard host routing — results (2026-09-14)

**Question.** Does one Worker, one proxied `*.lumenize.dev` DNS record and one Workers route serve every host depth [ADR-021](../../docs/adr/021-every-scope-has-its-own-host.md) names, with a valid certificate? And do `__Host-` cookies and `Sec-Fetch-*` headers behave the way [ADR-022](../../docs/adr/022-every-session-lives-on-the-platform-host.md) assumes?

**Setup**, on `lumenize.dev` (Free Website zone, Advanced Certificate Manager on):

- **Worker** `experiment-wildcard-hosts` — `src/worker.js` echoes the host, the scope it parses from the host, the `Sec-Fetch-*` headers and the names of the cookies it received, and sets `__Host-experiment`.
- **Route** `*.lumenize.dev/*`, from `wrangler.jsonc`.
- **DNS** one proxied `AAAA` record, `*.lumenize.dev → 100::`.
- **Certificate** one advanced pack for `lumenize.dev`, `*.u1.lumenize.dev` and `*.g1.u1.lumenize.dev` — Google Trust Services, TXT validation, 90 days.

## Results

| Question | Result |
|---|---|
| Does one wildcard DNS record resolve every depth? | **Yes.** `u1`, `g1.u1`, `tenant1.g1.u1`, `manny--dev.g1.u1`, `ed--dev.g1.u1` and `platform` all resolved to Cloudflare edge addresses, A and AAAA, from the one `*.lumenize.dev` record. No record per universe or galaxy is needed. |
| Does one route reach the Worker at every depth? | **Yes.** Every host above answered 200 from the Worker, which parsed the scope from the `Host` header: `u1.g1.tenant1`, and persona `ed` in Star `dev`. |
| Does the certificate serve at depth? | **Yes.** Universal SSL served `u1.lumenize.dev`, and the advanced pack served `g1.u1` and `tenant1.g1.u1`. `x.tenant1.g1.u1.lumenize.dev`, one label past any certificate, failed the TLS handshake — a wildcard covers exactly one label, confirmed at the edge. |
| Does the apex resolve? | **No.** `lumenize.dev` has no record of its own, so the landing page needs one. |
| Does a two-letter persona label, `ed--dev`, work? | **Yes** — it resolves, serves and passes TLS under the wildcard, since the label is never named on the certificate. |
| How long does a certificate take for names validated before? | **`pending_validation` at +16 s, `active` at +27 s**, and the edge presented it by the first check at +63 s. Both names, `*.u1` and `*.g1.u1`, had been validated in the 2026-09-11 run, which likely explains the speed. |
| How long does a certificate take for a name never validated before? | **`pending_validation` from +4 s to +145 s, `active` at +148 s, and `tenant1.g2.u1` answered 200 at that same 2-second poll.** `*.g2.u1.lumenize.dev` was new. On 2026-09-11, twenty new names ordered at once also took about 150 s to validate, so a new galaxy waits about two and a half minutes. |
| Does an active certificate serve straight away? | **Yes.** With the DNS record and route already in place, the host answered at the same poll that saw the certificate go active. |
| Is a `__Host-` cookie host-only? | **Yes.** Set on `tenant1.g1.u1`, sent back there on reload, and not sent to `ed--dev.g1.u1`. |
| Can a sibling host plant cookies? | **Only unprefixed ones.** From `ed--dev.g1.u1`, `document.cookie` with `Domain=lumenize.dev` accepted `plant` and silently refused `__Host-plant`. `plant` then arrived at `pat--dev.g1.u1` and at `platform.lumenize.dev`. |
| What `Sec-Fetch-*` values arrive? | A typed navigation: `none` / `navigate` / `document`. A same-origin `fetch`: `same-origin` / `cors` / `empty`. A script navigation from `pat--dev.g1.u1` to `platform.lumenize.dev`: **`same-site`** / `navigate` / `document` — so every `lumenize.dev` host is one site until a Public Suffix List entry lands. |

## Method notes

- **The first request to `manny--dev.g1.u1`, 20 s after deploy, returned 522.** Every retry of it, and of `pat--dev` and `manny--staging`, returned 200. That is the new route propagating, not the label.
- **Browser checks ran in the Claude desktop app's Chromium pane.** Safari and Firefox were not tested.
- **Times come from the shell's clock**, polling the certificate-packs API every 10 s for the first pack and every 2 s for the second.

## Teardown

**Done from the API on 2026-09-14:** the `*.lumenize.dev` DNS record and both certificate packs are deleted, and the zone again has no DNS records. Straight afterwards `tenant1.g1.u1.lumenize.dev` still answered 200, with resolvers holding the record in cache, and the zone's own Universal SSL pack briefly showed `pending_deployment`. A minute later the Universal pack was `active` again, `1.1.1.1` no longer resolved the test host, and both test packs sat in `pending_deletion`, as they did after the 2026-09-11 run.

**The Worker and its route stay until Larry's periodic sweep of `experiment-` Workers deletes `experiment-wildcard-hosts`**, which removes the route with it. This directory's `workspaces` entry goes when the experiment is pruned.

## Route precedence (2026-09-15)

**Question.** Can a second deployment own every host under `test.lumenize.dev` through a route `*.test.lumenize.dev/*`, while another Worker holds `*.lumenize.dev/*` on the same zone? It was a candidate home for the deployed test target in `tasks/nebula-scope-moves-to-subdomain.md`, which chose `lumenize-test.dev` instead after this run (§ *Decisions*).

**Setup.** The Worker above, deployed twice and told apart by an `ARM` var:

- **`wide`** — `experiment-wildcard-hosts`, route `*.lumenize.dev/*`.
- **`test-suffix`** — `experiment-wildcard-hosts-test` from `wrangler.test-suffix.jsonc`, routes `*.test.lumenize.dev/*` and `*.test--lmz.lumenize.dev/*`.
- **DNS** — one proxied `AAAA` record, `*.lumenize.dev → 100::`.
- **Plain `http`**, since no certificate covers two labels; the zone's `Always Use HTTPS` is off.

| Host | Answered by |
|---|---|
| `x.lumenize.dev`, `test-kitchen.lumenize.dev`, `tes.lumenize.dev` | `wide` |
| `x.test.lumenize.dev`, `tenant1.crm.acme.test.lumenize.dev` | `test-suffix` |
| `test.lumenize.dev` | `wide` |
| **`contest.lumenize.dev`, `crm.contest.lumenize.dev`, `latest.lumenize.dev`, `atest.lumenize.dev`** | **`test-suffix`** |
| `x.test--lmz.lumenize.dev`, `tenant1.crm.acme.test--lmz.lumenize.dev` | `test-suffix` |
| `test--lmz.lumenize.dev` | `wide` |
| `atest--lmz.lumenize.dev` | `test-suffix` |

- **The more specific route wins, whichever is newer.** The `wide` route was then deleted and recreated, so it was the newest of the three, and every host answered as before.
- **`*.test.lumenize.dev/*` matches any host ending in `test.lumenize.dev`, not only hosts under `test.`** `contest.lumenize.dev` is a legal universe, and it and every host beneath it went to the test Worker. The docs warn that `*` matches any characters; the dot after it anchors nothing.
- **The bare base host needs a route of its own.** `test.lumenize.dev` fell to `wide`.
- **A base label containing `--` closes the capture for real hosts.** `*.test--lmz.lumenize.dev/*` also matched `atest--lmz.lumenize.dev`, but `isValidSlug` refuses `--`, so no universe slug can end in `test--lmz`.

**Not measured:** whether a certificate authority issues `*.test--lmz.lumenize.dev`. Its `--` sits at positions five and six, and the reserved form is positions three and four, so it should.

**Method note.** The first probe pass used curl's `--doh-url` and failed on every host; plain resolution answered `200` seven minutes later. The cause, the flag or early propagation, was not isolated, so that pass is not a result.

**Teardown, done from the API the same day:** the DNS record and all three routes are deleted. Both Workers stay for Larry's sweep.

## Local wildcard hosts (2026-09-16)

**Question.** Do `*.lumenize.localhost` hosts resolve to loopback with no configuration, on the systems the local stack and CI run on? [The subdomain build](../../tasks/nebula-scope-moves-to-subdomain.md) rests its local venue on it.

**macOS: yes.** Measured 2026-09-15 by a scratch probe, Node 24.19 with Playwright's Chromium 145. Node's `fetch` and `WebSocket` and Chromium resolved every depth to loopback with no `/etc/hosts` entry; Chromium stored `Secure` and `__Host-` cookies over plain `http` there, kept them host-only, and treated every such host as one site. That script was not kept, and the task file carries the findings.

**Linux: no, at any depth.** Measured 2026-09-16 — the bare name fails too, so this is not about depth:

```sh
docker run --rm node:24-slim node -e '
const http=require("http"),dns=require("dns");
const s=http.createServer((q,r)=>r.end("ok:"+q.headers.host));
s.listen(8123,"127.0.0.1",async()=>{
  for (const h of ["lumenize.localhost","dev.crm.acme.lumenize.localhost"]) {
    try { const a=await dns.promises.lookup(h); console.log("lookup",h,"→",a.address) }
    catch(e){ console.log("lookup",h,"→ FAIL",e.code) }
  }
  try { const r=await fetch("http://dev.crm.acme.lumenize.localhost:8123/"); console.log("fetch →",r.status,await r.text()) }
  catch(e){ console.log("fetch → FAIL",e.cause?.code||e.message) }
  s.close()
})'
```

```
lookup lumenize.localhost → FAIL ENOTFOUND
lookup dev.crm.acme.lumenize.localhost → FAIL ENOTFOUND
fetch → FAIL ENOTFOUND
```

A Debian container is not a GitHub runner, whose Ubuntu carries systemd-resolved — but the CI lane that would find out is `ui-smoke`, and a mapping removes the question rather than answering it.

**What follows.** The local stack states its own wildcard, standing in for the `*.lumenize.dev` DNS record rather than for any behaviour of ours: Chromium takes `--host-resolver-rules=MAP *.lumenize.localhost 127.0.0.1`, and Node's `fetch` takes a `lookup` hook over the same suffix. Resolution is client-side either way — `wrangler dev` binds a port and reads the `Host` header, so it needs none of this.

## One pack per galaxy (2026-09-16)

**Question.** Can a galaxy's own certificate pack name its exact host beside its wildcard — `g9.u9.lumenize.dev` and `*.g9.u9.lumenize.dev` — so that no universe wildcard is ever needed? A universe host already rides Universal SSL, and every Star and persona rides the galaxy's wildcard, so the galaxy host itself is the only name a universe wildcard would cover.

**Setup**, on `lumenize.dev`, driven through the API with the account's global key; the zone had no DNS records and no routes to start:

- **Pack** — one advanced pack, hosts `lumenize.dev`, `g9.u9.lumenize.dev` and `*.g9.u9.lumenize.dev`, Google Trust Services, TXT validation, 90 days. Neither name had been validated before.
- **DNS** — one proxied `AAAA` record, `*.lumenize.dev → 100::`.
- **Route** — `*.lumenize.dev/*` to `experiment-wildcard-hosts`, still deployed from the 2026-09-14 run.

**Timing.** `pending_validation` at +15 s, `active` at **+233 s**. The 2026-09-14 run's never-validated name went active at +148 s, so the spread for a new galaxy is roughly two and a half to four minutes.

**Before the pack went active**, `u9.lumenize.dev` already answered 200 on the Universal pack, and `h9.u9`, `g9.u9` and `dev.g9.u9` all failed their TLS handshake. **After:**

| Host | HTTP | Certificate that answered its SNI |
|---|---|---|
| `g9.u9.lumenize.dev` — the galaxy | 200 | `lumenize.dev`, `g9.u9.lumenize.dev`, `*.g9.u9.lumenize.dev` |
| `dev.g9.u9.lumenize.dev` — a Star | 200 | the same pack |
| `manny--dev.g9.u9.lumenize.dev` — a persona | 200 | the same pack |
| `u9.lumenize.dev` — the universe | 200 | Universal: `lumenize.dev`, `*.lumenize.dev` |
| `h9.u9.lumenize.dev` — a sibling galaxy with no pack | handshake failure | none |
| `x.dev.g9.u9.lumenize.dev` — one label past the wildcard | handshake failure | none |

**What follows.** A galaxy needs exactly one pack and a universe needs none. The sibling galaxy failing is what shows no universe wildcard was doing the work, so each galaxy's pack names its own host. That halves the packs a single-galaxy customer costs against the zone's unpublished limit.

**Checked with** `openssl s_client -servername {host}` for the certificate and `curl --resolve` against an address from `1.1.1.1`, which sidesteps a stale local `NXDOMAIN` for names that did not exist before the run.

**Teardown, done from the API the same day:** the route, the DNS record and the pack are deleted. The pack sat in `pending_deletion` straight afterwards, and the Universal pack stayed `active`. `experiment-wildcard-hosts` stays for Larry's sweep.
