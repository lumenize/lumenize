# @lumenize/ts-runtime-validator

> ⚠️ **Deprecated.** This package has been superseded by [`@lumenize/ts-runtime-parser-validator`](https://www.npmjs.com/package/@lumenize/ts-runtime-parser-validator), which has the same TypeScript-as-schema model with parse-don't-just-validate semantics, recursive `@default` filling, and Cloudflare Durable Object facet hosting for same-isolate-RPC speed. See the announcement post: [https://lumenize.com/blog/introducing-parse-validator/](https://lumenize.com/blog/introducing-parse-validator/).
>
> No migration guide — the new package is framed as a fresh package, not a successor. See its [Getting Started](https://lumenize.com/docs/ts-runtime-parser-validator/getting-started) for setup.

---

TypeScript IS the schema — validate JavaScript values against TypeScript interfaces at runtime using the real tsc compiler.

- **Zero DSL** — use your existing TypeScript interfaces as the validation schema
- **Real tsc diagnostics** — error messages identical to what your editor shows
- **Rich types** — Maps, Sets, Dates, RegExps, URLs, TypedArrays, cyclic structures
- **Cross-platform** — Node.js, Bun, Cloudflare Workers, browsers

## Installation

This package is deprecated. Install the replacement instead:

```bash
npm install @lumenize/ts-runtime-parser-validator
```

## Documentation

The original package's docs remain at [lumenize.com/docs/ts-runtime-validator](https://lumenize.com/docs/ts-runtime-validator/) for reference, but new development should use the [parse-validator docs](https://lumenize.com/docs/ts-runtime-parser-validator/).

## License

MIT
