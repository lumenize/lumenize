# GitHub Actions for Publishing & Releases

**Status**: Research Complete - Deferred Implementation  
**Date**: 2024

## Goal
Automate publishing to npm and creating GitHub releases with changelogs.

## Key Findings

### Modern Token Approach
- **Static tokens being phased out**: npm deprecating TOTP 2FA in favor of rotating keys.
- **Modern approach**: GitHub Actions with OIDC (OpenID Connect) - no static tokens needed.
- **npm provenance**: Cryptographic proof of package origin, built into modern npm publishing.
- **Draft releases**: Can auto-generate release notes, then hand-edit before publishing.

### Recommended Workflow
1. GitHub Actions triggers on version tags (`v*`).
2. Runs tests, publishes to npm with `--provenance` flag.
3. Creates **draft** GitHub release with auto-generated notes from commits/PRs.
4. Manual review and editing of release notes.
5. Publish release when satisfied.

### Secrets Needed
**Only ONE secret**: `NPM_TOKEN` (automation token that rotates automatically).
- GitHub authentication handled via built-in `GITHUB_TOKEN` (auto-provided, no setup).
- No static tokens to manage or rotate manually.

## Implementation Plan

### Dependencies
- None scheduled; for now, continuing with local `npm run publish` workflow.

### Files to Create
- `.github/workflows/publish.yml` - Main publish workflow.
- `.github/workflows/release.yml` - Release creation workflow (draft mode).

### Benefits of Waiting
- Learn more about team workflow preferences before automating.
- Can hand-edit releases via GitHub UI in the meantime (always possible, even after automation).
