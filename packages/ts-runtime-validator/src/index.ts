/**
 * @lumenize/ts-runtime-validator
 *
 * TypeScript-as-schema runtime validation.
 * - `toTypeScript()` serializes values to TS programs (this phase)
 * - `validate()` type-checks them with tsc (Phase 5.2.2)
 */

export { toTypeScript } from './to-typescript';
