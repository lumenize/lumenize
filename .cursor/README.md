# Cursor AI Configuration

This directory contains Cursor IDE configuration for the Lumenize project.

## Structure

### `/rules/` - Passive Guidelines

These files (`.mdc` format) define coding standards, patterns, and "what to do/avoid":

- `critical-never.mdc` - Foot-guns to avoid (npm vs pnpm, async storage, etc.)
- `cloudflare-do.mdc` - Durable Objects patterns and gotchas
- `code-patterns.mdc` - TypeScript conventions, imports, package structure
- `testing.mdc` - Test philosophy and patterns
- `documentation.mdc` - Documentation standards and tooling

**When they apply:** Cursor loads matching rules when you open/edit files.

### `/commands/` - Active Workflows

These files (`.md` format) define step-by-step processes with explicit human/AI/code collaboration:

- `documentation-workflow.md` - 4-phase doc creation process
- `api-refactor.md` - Safe API refactoring pattern
- `task-management.md` - Managing tasks/ directory
- `release-workflow.md` - Publishing to npm

**How to use:** Type `/` in Cursor or open command palette to see these shortcuts.

## Migration from `.cursorrules`

This structure replaces the legacy `.cursorrules` file (which still exists at repo root for backward compatibility).

**Benefits of new structure:**
- Better organization by domain
- Easier to find specific guidance
- Explicit workflows with human-in-the-loop steps
- Can evolve rules independently

## Rules vs Commands

**Rules** answer "What?" and "Why?":
- Coding standards
- Patterns to follow
- Things to avoid
- Best practices

**Commands** answer "How?" and "Who?":
- Step-by-step workflows
- Who does what (AI, human, code)
- Order of operations
- Integration with scripts

## Reference

For comprehensive project context and background, see:
- `AGENTS.md` - High-level project overview
- `CLOUDFLARE_DO_GUIDE.md` - Durable Objects concepts
- `DOCUMENTATION-WORKFLOW.md` - Detailed doc process
- Root `.cursorrules` - Legacy rules file (can be deprecated)

