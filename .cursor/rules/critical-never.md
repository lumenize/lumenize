# Critical "Never Do This" Rules

These are the foot-guns to avoid in Lumenize development.

## Always

- ✅ Use **npm** only
- ✅ Use **`#` prefix** for private class members
- ✅ Use **synchronous storage** (`ctx.storage.kv.*` or `ctx.storage.sql.*`)
- ✅ Use **`wrangler types`** to auto-generate `worker-configuration.d.ts`
- ✅ Use **`compatibility_date: "2025-09-12"`** or later
- ✅ Use **root `.dev.vars`** (gitignored, auto-symlinked via postinstall)
- ✅ Put docs in **`/website/docs/`** `.mdx` files only

## Never

- ❌ **NEVER use pnpm or yarn** - only npm
- ❌ **NEVER use TypeScript `private`** - use `#` prefix instead
- ❌ **NEVER use async storage** - only `ctx.storage.kv.*` or `ctx.storage.sql.*` (not `ctx.storage.put/get`)
- ❌ **NEVER manually define Env interface** - `wrangler types` auto-generates it
- ❌ **NEVER use wrangler compatibility_date before "2025-09-12"**
- ❌ **NEVER commit secrets** - use root `.dev.vars` (gitignored)
- ❌ **NEVER create temp docs** - only `/website/docs/` `.mdx` files

## Why These Rules Exist

- **npm only**: Consistent dependency resolution, no workspace conflicts
- **`#` prefix**: True privacy at runtime, TypeScript `private` is compile-time only
- **Synchronous storage**: Cloudflare's embedded SQLite is synchronous, no performance penalty
- **Auto-generated types**: Prevents drift between wrangler.jsonc and TypeScript
- **2025-09-12 compatibility**: Required for synchronous storage API
- **Root .dev.vars**: Single source of truth, auto-symlinked to test directories
- **No temp docs**: Documentation lives only in the website, validated via check-examples

## Reference

For detailed Durable Objects concepts, see `CLOUDFLARE_DO_GUIDE.md` at repo root.
For general project context, see `AGENTS.md` at repo root.

