/**
 * @lumenize/ts-runtime-validator
 *
 * TypeScript-as-schema runtime validation.
 * - `toTypeScript()` serializes values to TS programs
 * - `validate()` type-checks them with tsc
 */

export { toTypeScript } from './to-typescript';
export { validate } from './validate';
export type { ValidationResult, ValidationError } from './validate';
export { extractTypeMetadata } from './extract-type-metadata';
export type { TypeMetadata, Relationship } from './extract-type-metadata';
