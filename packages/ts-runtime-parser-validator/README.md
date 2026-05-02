# @lumenize/ts-runtime-parser-validator

**Experimental.** Runtime parser/validator for Cloudflare Workers, built on [typia](https://typia.io/). Parse-don't-validate: one call fills `@default` values and validates against TypeScript interfaces, returning typed data or structured errors.

For complete documentation, visit **[https://lumenize.com/docs/ts-runtime-parser-validator/introduction](https://lumenize.com/docs/ts-runtime-parser-validator/introduction)**

This package supersedes the tsc-based [`@lumenize/ts-runtime-validator`](https://www.npmjs.com/package/@lumenize/ts-runtime-validator), which is now deprecated. The old package was experimental with no known external users, so we didn't write a migration guide — treat this as a fresh package and see [Getting Started](https://lumenize.com/docs/ts-runtime-parser-validator/getting-started).

## Installation

```bash
npm install @lumenize/ts-runtime-parser-validator
```
