# Test Files Organization

This directory contains two types of tests for the `@lumenize/testing` library:

## `basic-usage.test.ts` 
**Purpose**: Living documentation and learning resource  
**Audience**: Developers learning to use `@lumenize/testing`  
**Style**: Verbose comments, clear step-by-step examples  

Shows fundamental usage patterns:
- Setting up `testDOProject()`
- Three ways to access DO stubs 
- Using the ctx proxy for internal testing
- Working with the three-method API (`get`/`ctx`/`full`)
- DO instance isolation testing

## `comprehensive.test.ts`
**Purpose**: Complete library validation and testing  
**Audience**: Library development and CI/CD  
**Style**: Thorough coverage, concise but complete  

Validates all features and edge cases:
- Complete DO access pattern coverage
- Full ctx proxy functionality testing  
- Map serialization with structured clone
- Three-method API comprehensive validation
- Registry tracking and management
- All storage operations and data types

## Migration Strategy

- `basic-usage.test.ts` will remain in examples indefinitely as documentation
- `comprehensive.test.ts` will eventually be migrated to `@lumenize/testing/test/` for proper CI/CD integration
- New features should be tested in `comprehensive.test.ts` first, then documented in `basic-usage.test.ts` if user-facing