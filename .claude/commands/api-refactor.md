# API Refactor

Safely refactor APIs by validating one test before updating all.

## Usage
`/api-refactor <package-name>`

## Process
1. Mark one representative test as `.only`
2. Implement the new API pattern in that test
3. Run `npm test` until it passes
4. Update remaining tests to match
5. Remove `.only` and run full suite

## Rules
- Never update all tests simultaneously
- Never leave `.only` in committed code
- Never create backward-compatible shims to avoid test updates
