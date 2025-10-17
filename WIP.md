# Work In Progress (WIP)

## Quick Reference: Release Commands

```bash
# Test everything without publishing
npm run release:dry-run

# Actual release (interactive - will prompt for version bump)
npm run release

# Deploy website separately (can be done anytime)
cd website && npm run deploy
```

## Later and possibly unrelated

- [ ] Remove this example: https://lumenize.com/docs/rpc/api/functions/lumenizeRpcDO. 
- [ ] Search for all examples in JSDoc and remove them
- [ ] Switch all use of 'private' typescript keyword to JavaScript '#'
- [ ] Add a new signature for createRpcClient that's like createTestingClient's
- [ ] Think about how we might recreate the inspect messages functionality we had in @lumenize/testing
- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube account over to the lumenize repo
- [ ] We need much more security info on the website. Maybe an entire .mdx. Here is the completely inadequate warning we had in the README before we thinned it down. 
  ⚠️ **IMPORTANT**: This package exposes your DO internals via RPC endpoints. Only use in development or secure the endpoints appropriately for production use.
- [ ] Possible additional testing for rpc
  - [ ] Add timeout testing to matrix
  - [ ] Add memory leak testing (WebSocket connections)
  - [ ] Test in production on Cloudflare (not just local with vitest)
