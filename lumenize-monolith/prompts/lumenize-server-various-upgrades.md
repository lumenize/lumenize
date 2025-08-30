# Various Small(ish) Upgrades to Lumenize (server)

- [ ] Logo!
- [ ] Push JurisJS-based lumenize.com. Markdown with config. Not Astro complexity.
- [ ] Implement mono-repo and move stuff around. Leave it in the mcp workspace for now. All the current lumenize moves to `lumenize-old/`. The new lumenize will be built in `lumenize/` but that's a week or so away, because...
- [ ] Build @lumenize/base and @lumenize/router
- [ ] Build @lumenize/testing
- [ ] Build @lumenize/plugin-sql
- [ ] Build @lumenize/mcp

## @lumenize/base and @lumenize/router
- [ ] Remove dependency on PartyServer and routePartyRequest
  - [ ] Copy them into lumenize
  - [ ] Get rid of auto-coversion of the binding to kebab-case and recommend that you make your binding be OK for your URLs. Note these are essentially back-end URLs so your users won't see them except in the development console. I recommend that you make yor binding match your class name so PascalCase.
  - [ ] Change routePartyRequest to implement our universe.galaxy.star structure. We want the first segment after the name to be a period delimited path. So, first confirm that we do NOT allow periods in those slugs. Then, make it look like, `lumenize.com/${universe}.${galaxy}.${star}/...`. Later, we could allow custom domains so `my-domain.com/${universe}.${galaxy}.${star}/...`
  - [ ] PartyServer captures the name id of the DO instance from the url. We want that to be the first segment after the domain defined above, rather than the second.
  - [ ] That is complicated by this automatic name capture in PartyServer. We may have to fork PartyServer and rip out stuff that we don't want and change some other stuff like this. https://github.com/cloudflare/partykit/blob/main/packages/partyserver/src/index.ts
- [ ] Remove dependency on PartySocket
- [ ] Should switch to ULIDs
- [ ] Test Lumenize from Cloudflare MCP Playground
