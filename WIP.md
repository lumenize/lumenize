# Work In Progress (WIP)

## Current Focus

Nothing active - ready for next project!

---

## Backlog

- [ ] We need true integration tests for the Queue variant of proxy-fetch
- [ ] Writeup my RPC performance findings and put it up as a doc on the website
- [ ] Show that private methods are not available over Lumenize RPC
- [ ] Need to test/demo this with Lumenize RPC. Notice the use of the first as a parameter in the second:
  - An RpcPromise also acts as a stub for the eventual result of the promise. That means, you can access properties and invoke methods on it, without awaiting the promise first.
    ```ts
    // In a single round trip, authenticate the user, and fetch their notifications.
    let user = api.authenticate(cookie);
    let notifications = await user.getNotifications();
    ```
  - An RpcPromise (or its properties) can be passed as parameters to other RPC calls.
    ```ts
    // In a single round trip, authenticate the user, and fetch their public profile
    // given their ID.
    let user = api.authenticate(cookie);
    let profile = await api.getUserProfile(user.id);
    ```
- [ ] Add examples and docs for plucking the bindingName and instanceNameOrId out of headers into storage for the DO
- [ ] Add `TypeBox Value` support for RPC runtime checking (both TypeBox and JSON Schema) but don't make TypeBox a dependency. That last could be tricky since it'll have to sense if it's a TypeBox spec, or a JSON Schema spec.
- [ ] Move debugOff into @lumenize/utils
- [ ] Need a way to control debug messages more granularly from a global config. Maybe markers like the old debug library I used to use that would check localhost or env variable but maybe not that. Maybe some global static. Maybe we encourage scoped "where" clauses in the debug output?
- [ ] Make changes to docs to document promise pipelining. Right now it's in quirks, but pull it out to its own thing.
- [ ] Make websocket-shim throw when passed in http[s] urls like the real browser. This requires changing a lot of tests especially the matrix tests that run the same test but just varying transport.
- [ ] Consider forking @ungap/structured-clone to claim no dependencies
- [ ] Deploy to Cloudflare button
- [ ] Move SonarQube Cloud (or whatever it's called now. It was previously SonarCloud, I think) account over to the lumenize repo
- [ ] We need much more security info on the website. Maybe an entire .mdx. Here is the completely inadequate warning we had in the README before we thinned it down. 
  ⚠️ **IMPORTANT**: This package exposes your DO internals via RPC endpoints. Only use in development or secure the endpoints appropriately for production use.
- [ ] Test in production on Cloudflare (not just local with vitest)

### GitHub Actions for Publishing & Releases

**Goal**: Automate publishing to npm and creating GitHub releases with changelogs

**Research Completed**: Investigated secure token approaches and GitHub Actions workflow

**Key Findings**:
- **Static tokens being phased out**: npm deprecating TOTP 2FA in favor of rotating keys
- **Modern approach**: GitHub Actions with OIDC (OpenID Connect) - no static tokens needed
- **npm provenance**: Cryptographic proof of package origin, built into modern npm publishing
- **Draft releases**: Can auto-generate release notes, then hand-edit before publishing

**Recommended Workflow**:
1. GitHub Actions triggers on version tags (`v*`)
2. Runs tests, publishes to npm with `--provenance` flag
3. Creates **draft** GitHub release with auto-generated notes from commits/PRs
4. Manual review and editing of release notes
5. Publish release when satisfied

**Only ONE secret needed**: `NPM_TOKEN` (automation token that rotates automatically)
- GitHub authentication handled via built-in `GITHUB_TOKEN` (auto-provided, no setup)
- No static tokens to manage or rotate manually

**Dependencies for Later**:
- Will be implemented when SonarQube Cloud integration is added
- SonarQube scan + unified test coverage reports will use same GitHub Actions infrastructure
- For now, continuing with local `npm run publish` workflow

**Reference Files to Create**:
- `.github/workflows/publish.yml` - Main publish workflow
- `.github/workflows/release.yml` - Release creation workflow (draft mode)

**Benefits of Waiting**:
- Single GitHub Actions setup for both publishing and code quality scanning
- Learn more about team workflow preferences before automating
- Can hand-edit releases via GitHub UI in the meantime (always possible, even after automation)
