# Website Refactor for Initial Lumenize Mesh Release

Must have (pre-release):
- [x] Code:
  - [x] Fix bootstrap problem for LumenizeClient
    - [x] Upgrade Browser with BroadcastChannel and sessionStorage in support of testing above
  - [x] Fix Worker call() bugs (missing __localChainExecutor, missing bindingName validation)
    - [x] Worker callRaw() and call() tests (18 new tests in lumenize-worker.test.ts)
  - [x] Gateway must close old connection when new one arrives
  - [x] Make Turnstile and Rate Limiting optional but point to their config at bottom of getting-started.mdx
  - [x] Refactor Gateway
  - [x] Get test coverage up to targets
  - [x] Resolve remaining skip-checks
  - [x] Get real email working with auth system
- [x] Website home page rewrite
  - [x] Tag line
  - [x] Hero sections
  - [x] Products (one paragraph each and then links to docs for each except Nebula)
    - [x] Mesh marked beta
    - [x] Auth marked beta
    - [x] debug marked GA
    - [x] Nebula marked coming soon
- [x] Website - what to do with older packages
  - [x] Move RPC under Testing and mark with "use Mesh instead"
  - [x] Actor Alarms - archive except keep doc-testing folder
  - [x] Cap'n Web comparison - archive except keep doc-testing folder
- [x] Blog
  - [x] Announcing Lumenize Mesh and Auth

Should have (immediately post-release) — tracked in `tasks/mesh-post-release.md`:
- [ ] Duplicate email setup for auth in mesh/getting-started.mdx
- [ ] Working Document editor system example
  - [ ] Deploy to Cloudflare button
  - [ ] What to use for UI?
- [ ] At least one example from Agent
- [ ] Blog
  - [ ] Gateway pattern
    - [ ] Experiments on Gateway latency
      - [ ] Direct to DO round trip
      - [ ] Mesh round trip - expect +20ms or so
      - [ ] Direct to DO to Worker back to DO back to client
      - [ ] Mesh three one-way calls - expect even w/ above

Could have (later):
- [ ] Experiments
  - [ ] When do we hit max sub-request limit
- [ ] @lumenize/resources NADIS plugin
  - [ ] ORM-like concept
    - [ ] Binary JSON
    - [ ] JSON-schema validation
    - [ ] Every resource can have more than one schema
      - [ ] Disallow changing the default that allows additional fields
    - [ ] Indexes
      - [ ] Partial indexes for each schema
  - [ ] Subscribe
  - [ ] HTTP API
  - [ ] Schema
- [ ] Lumenize UI - A fork of JurisJS w/ 1st class support for get/setState
- [ ] Blog
  - [ ] Comparison to Agent
  - [ ] Comparison to Actor
  - [ ] Comparison to Cap'n Web
- [ ] Fanout service

Won't have:
- [ ] UseLumenize addon to LumenizeClient
