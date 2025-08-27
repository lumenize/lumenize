# Various Small(ish) Upgrades to Lumenize (server)

- [ ] Testing of our MCP server from Claude Desktop as described here: https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-authless
- [ ] Read every line of integration-entity-patch-subscription.test.ts and confirm the tests are correct and not redundant.
- [ ] Read every line of integration-entity-lifecycle.test.ts and confirm the tests are correct and not redundant.
- [ ] Ugh. I just now realized that PartyServer connections already assign an id. You can retrieve them by id using getConnection(id). We don't need tags. Funny enough, it uses the same trick we used. It has the client add a search parameter.
- [ ] I need to confirm if the PartyKit connection id survives a reconnect. If not, I need to alter it to do so. 
- [ ] PartyServer also captures the name id of the DO instance from the url. So, we don't need to do that. However, we were thinking about how to replace routePartyRequest with something that implements our universe/galaxy/star structure. That is complicated by this automatic name capture. We may have to fork PartyServer and rip out stuff that we don't want and change some other stuff like this. https://github.com/cloudflare/partykit/blob/main/packages/partyserver/src/index.ts
- [ ] Should switch to ULIDs
- [ ] 