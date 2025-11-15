# Contributing to Lumenize

Thank you for your interest in contributing to Lumenize! This document provides guidelines and instructions for developers.

## Getting Started

### Prerequisites
- Node.js >= 18
- npm (not pnpm or yarn)
- Git

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/lumenize/lumenize.git
   cd lumenize
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```
   This automatically runs the `prepare` script to set executable permissions on scripts.

3. **Verify everything works**
   ```bash
   npm test
   ```
   This runs all package tests and doc-tests (~380 tests total).

## Development Workflow

### AI-Assisted Development

Lumenize is designed for AI-assisted development using [Cursor](https://cursor.com) or similar AI pair programming tools. The repository includes structured rules and commands to guide AI assistants:

- **`.cursor/rules/`** - Project rules for coding standards, patterns, and workflows
- **`.cursor/commands/`** - Reusable workflow commands:
  - `/task-management` - Choose docs-first vs implementation-first workflow
  - `/documentation-workflow` - 5-phase validated documentation process

**Key Principle:** For user-facing features, use the **docs-first workflow** - design the API in documentation before writing code. See `.cursor/commands/task-management.md` for details.

### Project Structure

This is an npm workspaces monorepo with three publishable packages:
- `@lumenize/rpc` - RPC system for Durable Objects
- `@lumenize/testing` - Testing utilities for DOs
- `@lumenize/utils` - Utility functions

### Running Tests

```bash
# Run all tests (packages + doc-tests)
npm test

# Run only package tests
npm run test:code

# Run only doc-tests
npm run test:doc

# Run tests for a specific package
cd packages/rpc && npm test

# Run tests with coverage
cd packages/rpc && npm run coverage
```

### Type Checking

```bash
# Type check all publishable packages
npm run type-check

# Type check a specific package
cd packages/rpc && npm run type-check
```

### Making Changes

1. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write tests for new functionality
   - Ensure tests pass: `npm test`
   - Follow existing code style
   - Update docs in /website/docs and /doc-test if needed

3. **Commit your changes**
   ```bash
   git add .
   git commit -m "describe your changes"
   ```

4. **Push and create a Pull Request**
   ```bash
   git push origin feature/your-feature-name
   ```

## Coding Standards

### TypeScript Style
- Never use `private` keyword - use JavaScript `#` prefix for private fields
- Use TypeScript types for in-memory structures
- Use TypeBox schemas for anything crossing boundaries (network, persistence, process)

### Testing
- Aim for high branch coverage (80%+)
- Favor integration tests over unit tests
- When writing unit tests use minimal mocking and be careful the mocks don't just give you the answer you want to hear
- Each package has a `test/` directory with `.test.ts` files

### Documentation
- All user-facing docs go in `/website/docs/`
- Be sure to update sidebars.ts when you add or remove a doc or doc-test file. We have Docusaurus set to not auto-populate the sidebar
- Package README.md files should be minimal with link to docs
- Use doc-tests to ensure examples in docs always work
- ⚠️ **IMPORTANT**: Be careful not to hand edit the docs in `/website/docs` that are auto-generated from doc-tests. If you find yourself editing a `.mdx` with examples in them that look like tests, STOP, and make your edits in the corresponding doc-test.

## Development Scripts

```bash
# Testing
npm test              # Run all tests
npm run test:code     # Package tests only
npm run test:doc      # Doc-tests only

# Maintenance
npm run clean         # Remove build artifacts
npm run clean:all     # Full reset (reinstall everything)

# Release (maintainers only)
npm run release:dry-run  # Test release without publishing
npm run release          # Full release to npm
```

## Release Process (Maintainers Only)

We use Lerna for synchronized versioning and publishing.

1. **Ensure clean working directory**
   ```bash
   git status  # Should be clean
   ```

2. **Run dry-run to test**
   ```bash
   npm run release:dry-run
   ```

3. **Execute release**
   ```bash
   npm run release
   ```
   
   The script will:
   - Run all tests
   - Build packages
   - Prompt for version bump (patch/minor/major/custom)
   - Publish to npm
   - Create git tags
   - Restore dev mode
   - Commit and push changes

See [RELEASE.md](./RELEASE.md) for detailed release documentation.

## Need Help?

- Open an issue for bugs or feature requests
- Check existing issues before creating new ones
- Be respectful and constructive in discussions

## License

By contributing, you agree that your contributions will be licensed under the MIT License (for open-source packages) or BSI-1.1 (for restricted packages), as appropriate.
