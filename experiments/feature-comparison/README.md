# Feature Comparison: Lumenize RPC vs Cap'n Web

A de✨light✨ful living documentation comparing Lumenize RPC with Cap'n Web (Cloudflare's official RPC solution).

## Overview

This experimental package provides side-by-side comparisons of how Lumenize RPC and Cap'n Web handle various features and patterns. Each comparison focuses on developer experience (DX) differences and practical implications.

## Features Compared

- **Access to `ctx` and `env`**: How each framework provides access to DurableObjectState and environment bindings
- More features coming soon...

## Running the Tests

```bash
# Run all tests
npm run test

# Run with coverage
npm run coverage
```

## Documentation

The test file doubles as living documentation with extensive markdown comments explaining each comparison. See `test/feature-comparison.test.ts` for detailed analysis.

## Related Resources

- [Lumenize RPC Documentation](https://lumenize.com/docs/rpc/introduction)
- [Cap'n Web Blog Post](https://blog.cloudflare.com/capnweb-javascript-rpc-library/)
- [Cap'n Web GitHub](https://github.com/cloudflare/capnweb)
- [Performance Comparison](../performance-comparisons/)
