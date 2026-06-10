---
name: release-workflow
description: Publish all packages to npm with synchronized versioning (Lerna). Use when the user wants to release, publish, or cut a new version of the packages.
argument-hint: [dry-run|publish]
---

# Release Workflow

Publish all packages with synchronized versioning. This is the **only time a build runs** — publish scripts repoint `package.json` from `src/` to `dist/`, build, publish, then revert (see `.claude/rules/workflow.md` § Releases and § No build during development).

## Usage
`/release-workflow <dry-run|publish>`

## Scripts
All in `/scripts/`:
- `release-dry-run.sh` - Test release without publishing (always run first)
- `release.sh` - Actual publish
- `build-packages.sh` - Compile TypeScript to dist/
- `prepare-for-publish.sh` - Modify package.json for publish
- `restore-dev-mode.sh` - Revert to dev mode after publish

## Process

### Pre-release checks
1. Run `/review-skip-check-approved main` — verifies `@skip-check-approved` doc examples (excluded from automated testing) still match the source that's about to ship.
2. Ensure clean git state.

### Dry Run (Always First)
```bash
./scripts/release-dry-run.sh
```
Review output for issues before proceeding.

### Actual Release
1. Run `./scripts/release.sh`
2. Verify packages on npm
3. Test installation in clean environment

## Rules
- Always dry run first
- Never publish with uncommitted changes
- Flag breaking changes for major version increment (favor breaking changes over technical debt; the next release gets flagged accordingly)
