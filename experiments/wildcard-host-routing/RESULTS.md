# Wildcard host routing — results (2026-09-14)

**Question.** Does one Worker, one proxied `*.lumenize.dev` DNS record and one Workers route serve every host depth [ADR-021](../../docs/adr/021-every-scope-has-its-own-host.md) names, with a valid certificate? And do `__Host-` cookies and `Sec-Fetch-*` headers behave the way [ADR-022](../../docs/adr/022-each-host-holds-its-own-session.md) assumes?

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
