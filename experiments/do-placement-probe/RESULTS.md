# do-placement-probe: where a named Durable Object lands, by who touches it first (deployed)

**Question.** `tasks/archive/nebula-clients-connect-to-their-scope.md` § *Open questions*, item 2 proposes placing a new Galaxy by letting its creator's browser be the first thing to touch it, instead of hinting a region. That rests on three claims nobody had measured: a Worker's first touch places a named object at its PoP; an object's first touch, over a service binding, places a new one beside it; and a wiped object can or cannot be placed anew by its next touch.

**Method.** `experiment-do-placement-probe`, deployed 2026-10-05, driven from one Node process in Pittsburgh (PoP IAD). Every Worker invocation and every object reports its own colo from Cloudflare's trace endpoint (`cdn-cgi/trace`), so nothing is inferred.

- **Local first touch:** the Worker at IAD touches a fresh name.
- **Anchors:** one anchor object per `locationHint` region. From each, fresh names are first touched two ways: the anchor calls the Worker's `Toucher` entrypoint over a service binding, the way a host node calls the facade, and the anchor `fetch`es the Worker's public URL, the way a browser in that region would arrive.
- **Wipe:** a name first touched far away is wiped, either reset at once or left idle to be evicted, then touched from IAD.

The experiment imports nothing, so it is deliberately not in the root `workspaces` and runs with the repo's own wrangler (`cd apps/nebula && npx wrangler deploy -c ../../experiments/do-placement-probe/wrangler.jsonc`).

## Results (2026-10-05)

### A Worker's first touch places a named object at its PoP

The Worker at IAD first-touched six fresh names: five landed in IAD and one in EWR, the next Durable Object location along the same coast.

### An object's first touch places a new object beside it

Each row is one anchor, then two fresh names touched over the service binding and two over a public fetch, written `Worker colo → new object's colo`:

| Hint | Anchor | Service binding | Public fetch |
|---|---|---|---|
| `wnam` | SEA | SEA→SEA, SEA→SEA | SEA→SEA, SEA→SEA |
| `enam` | EWR | EWR→EWR, EWR→EWR | EWR→EWR, EWR→EWR |
| `sam` | IAD | IAD→IAD, IAD→IAD | IAD→IAD, IAD→IAD |
| `weur` | LHR | LHR→LHR, LHR→LHR | LHR→LHR, LHR→LHR |
| `eeur` | OTP | OTP→OTP, OTP→OTP | OTP→OTP, OTP→OTP |
| `apac` | SIN | SIN→SIN, SIN→SIN | SIN→SIN, SIN→SIN |
| `oc` | BNE | BNE→SYD, BNE→BNE | BNE→BNE, BNE→BNE |
| `afr` | AMS | AMS→AMS, AMS→AMS | AMS→AMS, AMS→AMS |
| `me` | FRA | FRA→AMS, FRA→FRA | FRA→AMS, FRA→FRA |

- **The Worker an object calls runs in the object's own colo**, over a service binding and over a public fetch alike. So a host node that relays a Client's `createGalaxy` to the facade places the new Galaxy beside the host node, not beside the person.
- **The new object lands in that colo or the next one**, 33 of 36 in the same colo.

### A hint names a region, and the region is wide

Across both runs, anchors hinted to `apac` landed in Singapore (SIN), Tokyo (NRT) and Hong Kong (HKG); `oc` in Brisbane (BNE), Sydney (SYD) and Melbourne (MEL); and `weur` in London (LHR), Paris (CDG) and Amsterdam (AMS). `sam` placed nothing in South America: its anchor landed in IAD. `afr` landed in Amsterdam and `me` in Frankfurt. A person in Auckland hinted to `oc` could get any of three Australian cities, and one hinted to `apac` could get Singapore or Tokyo, thousands of kilometres apart, which is the gap Larry has heard South Pacific users describe.

### A named object's placement is permanent

Each name was first touched from an anchor far away, read once from IAD for its boot id, marked, wiped, then left for 5 s after a reset or 180 s idle, and touched from IAD again:

| Hint | Wipe | First life | Touched again from | Lands | Boot id | Mark |
|---|---|---|---|---|---|---|
| `apac` | reset | HKG | IAD | HKG | changed | gone |
| `apac` | idle 180 s | NRT | IAD | NRT | changed | gone |
| `oc` | reset | BNE | IAD | BNE | changed | gone |
| `oc` | idle 180 s | SYD | EWR | SYD | changed | gone |
| `weur` | reset | AMS | IAD | AMS | changed | gone |
| `weur` | idle 180 s | AMS | IAD | AMS | changed | gone |

- **Storage gone, instance new, place unchanged, six of six.** The object came back where its first life was placed, though nothing of that life survived and the touch came from the other side of the world.
- **The first run of this step was wrong, and is not counted.** It reset the object right after `deleteAll` without yielding, so the reset discarded the delete and the mark survived. That is `.claude/rules/durable-objects.md`'s persist-before-abort trap, and the 200 ms yield in `ProbeDO.wipe` is the fix. That run also recorded no boot ids, so it could not show the objects had been evicted.

## What this settles

- **A browser's own arrival is the most precise placement there is.** The Worker at a person's PoP places a new named object at that PoP's Durable Object location or the next one along, with no hint. Open question 2's proposal rests on this, and it holds.
- **A relay places beside the relayer.** Through a host node, a new Galaxy would be placed beside the Universe, so hosting needs open question 2's fix and cannot simply relay creation.
- **A hint is the coarse fallback it looked like.**
- **Whoever touches a name first places it for good.** A wipe cannot undo a bad placement, so the only defence is that nothing touches a name before the person it should sit near. Reusing a deleted name keeps its first life's place.

## Rerun

```sh
cd apps/nebula && npx wrangler deploy -c ../../experiments/do-placement-probe/wrangler.jsonc
openssl rand -hex 16 | tee /tmp/placement-token | npx wrangler secret put BENCH_TOKEN -c ../../experiments/do-placement-probe/wrangler.jsonc
cd ../../experiments/do-placement-probe
BENCH_BASE_URL=https://experiment-do-placement-probe.<account>.workers.dev BENCH_TOKEN=$(cat /tmp/placement-token) node scripts/probe.mjs
# ONLY=local|anchors|replace runs one step; IDLE_MS sets the idle wait in the wipe step
```

Raw results are in `results/`. Delete the Worker from the dashboard when done, which also removes its Durable Object namespaces.
