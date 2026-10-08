/**
 * @lumenize/ts-runtime-parser-validator — experimental
 *
 * Parse-don't-validate runtime type checker built on typia.
 * See https://lumenize.com/docs/ts-runtime-parser-validator/introduction
 *
 * This is the COMPILE entry (`@lumenize/ts-runtime-parser-validator/compile`): it
 * carries the bundled tsc/typia (multi-MB, work at module scope), so nothing on a
 * deployed Worker's import graph may reach it. A consumer that only loads
 * pre-generated validators imports `…/runtime` (`./facet-helper.ts`) instead.
 */

export { generateParseModule } from './generate-parse-module';
export { checkTypeScript } from './virtual-ts-host';
export type { CheckResult } from './virtual-ts-host';
export { extractTypeMetadata } from './extract-type-metadata';
export type {
  TypeMetadata,
  Relationship,
  DefaultsMap,
} from './extract-type-metadata';
// The facet half (getParserValidatorFacet + its types) is deliberately NOT here: it
// imports `cloudflare:workers`, and this entry must stay loadable/type-checkable in
// plain Node (the /live harness, the validator-seeds generator, the container build
// job). It lives on the `./runtime` entry (`facet-helper.ts`) alone.
