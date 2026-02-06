# Website Refactor for Initial Lumenize Mesh Release

Must have:
- [ ] Code:
  - [x] Fix bootstrap problem for LumenizeClient
    - [x] Upgrade Browser with BroadcastChannel and sessionStorage in support of testing above
  - [x] Fix Worker call() bugs (missing __localChainExecutor, missing bindingName validation)
    - [x] Worker callRaw() and call() tests (18 new tests in lumenize-worker.test.ts)
  - [ ] Gateway must close old connection when new one arrives
  - [ ] Make Turnstile and Rate Limiting optional but point to their config at bottom of getting-started.mdx
  - [ ] Refactor Gateway depending upon results of experiment to confirm alarm takes storage
  - [ ] Get test coverage up to targets
- [ ] Website home page rewrite
  - [ ] Tag line
  - [ ] Hero sections
  - [ ] Products
    - [ ] Mesh beta
    - [ ] Auth beta
    - [ ] debug
    - [ ] Nebula - coming soon
- [ ] Website - what to do with older packages
  - [ ] Move RPC under Testing and mark with "use Mesh instead"
  - [ ] Actor Alarms - archive except keep doc-testing folder
  - [ ] Cap'n Web comparison - archive except keep doc-testing folder
- [ ] Blog
  - [ ] Announcing Lumenize Mesh and Auth

Should have:
- [ ] Working Document editor system example
  - [ ] Deploy to Cloudflare button
  - [ ] What to use for UI?
- [ ] At least one example from Agent
- [ ] Experiments
  - [ ] When do we hit max sub-request limit
- [ ] Blog
  - [ ] Gateway pattern
    - [ ] Experiments on Gateway latency
      - [ ] Direct to DO round trip
      - [ ] Mesh round trip - expect +20ms or so
      - [ ] Direct to DO to Worker back to DO back to client
      - [ ] Mesh three one-way calls - expect even w/ above
  - [ ] 

Could have:
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
