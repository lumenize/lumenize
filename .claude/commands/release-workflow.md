# Release Workflow

Publish all packages with synchronized versioning.

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

### Dry Run (Always First)
```bash
./scripts/release-dry-run.sh
```
Review output for issues before proceeding.

### Actual Release
1. Ensure clean git state
2. Run `./scripts/release.sh`
3. Verify packages on npm
4. Test installation in clean environment

## Rules
- Always dry run first
- Never publish with uncommitted changes
- Flag breaking changes for major version increment
