/**
 * Pure validate() function — validates a JavaScript value against TypeScript
 * type definitions at runtime by running the real TypeScript compiler.
 *
 * @see tasks/nebula-5.2.2-validate.md for full design
 */

import { toTypeScript } from './to-typescript';
import { checkFiles, type DiagnosticInfo } from './engine';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: ValidationError[] };

export interface ValidationError {
  message: string;
  code: number;
  source: 'type-definitions' | 'value';
  line?: number;
  property?: string;
}

// ---------------------------------------------------------------------------
// Size guard
// ---------------------------------------------------------------------------

const MAX_COMBINED_SIZE = 256 * 1024; // 256 KB

// ---------------------------------------------------------------------------
// Export/import stripping
// ---------------------------------------------------------------------------

/**
 * Strip export/import keywords from type definitions so tsc treats
 * the file as a script (global scope) rather than a module.
 */
export function stripExportsAndImports(typeDefinitions: string): string {
  return typeDefinitions
    .split('\n')
    .map((line) => {
      // Remove import lines
      if (/^\s*import\b/.test(line)) return '';

      // Remove export default lines
      if (/^\s*export\s+default\b/.test(line)) return '';

      // Remove re-export lines: export { ... } or export { ... } from '...'
      if (/^\s*export\s*\{[^}]*\}\s*(from\s*['"][^'"]*['"])?\s*;?\s*$/.test(line)) return '';

      // Strip export before declarations
      const declMatch = line.match(
        /^(\s*)export\s+(interface|type|enum|class|const|let|var|function|async\s+function|declare|abstract)\b/,
      );
      if (declMatch) {
        return line.replace(/^(\s*)export\s+/, '$1');
      }

      return line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Property extraction from tsc diagnostic messages
// ---------------------------------------------------------------------------

const PROPERTY_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // Missing single property: "Property 'title' is missing in type '{ done: boolean; }'"
  { re: /Property '([^']+)' is missing/, group: 1 },
  // Missing multiple properties: "Type '{}' is missing the following properties from type 'Todo': title, done"
  // Extract the first property name after the colon
  { re: /is missing the following properties from type '[^']+': (\w+)/, group: 1 },
  // Excess property: "...and '"key"' does not exist in type..." (toTypeScript uses JSON-quoted keys)
  { re: /and '([^']+)' does not exist in type/, group: 1 },
  // Property doesn't exist: "Property 'foo' does not exist on type 'Bar'"
  { re: /Property '([^']+)' does not exist on type/, group: 1 },
];

function extractProperty(message: string): string | undefined {
  for (const { re, group } of PROPERTY_PATTERNS) {
    const match = message.match(re);
    if (match) return match[group];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source mapping
// ---------------------------------------------------------------------------

function mapSource(fileName: string | undefined): 'type-definitions' | 'value' {
  if (fileName === 'schema.ts') return 'type-definitions';
  return 'value';
}

function toValidationError(d: DiagnosticInfo): ValidationError {
  const error: ValidationError = {
    message: d.message,
    code: d.code,
    source: mapSource(d.fileName),
  };
  if (d.line !== undefined) error.line = d.line;
  const prop = extractProperty(d.message);
  if (prop !== undefined) error.property = prop;
  return error;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate a JavaScript value against TypeScript type definitions at runtime.
 *
 * @param value - Any JavaScript value
 * @param typeName - The name of the interface/type to validate against
 * @param typeDefinitions - TypeScript interface/type definitions as a string
 * @returns ValidationResult — `{ valid: true }` or `{ valid: false, errors: [...] }`
 * @throws TypeError if typeDefinitions is empty or whitespace-only
 * @throws RangeError if combined program size exceeds 256 KB
 */
export function validate(
  value: unknown,
  typeName: string,
  typeDefinitions: string,
): ValidationResult {
  // Guard: empty type definitions
  if (!typeDefinitions.trim()) {
    throw new TypeError('typeDefinitions must not be empty');
  }

  // Generate the TypeScript program from the value
  const generatedProgram = toTypeScript(value, typeName);

  // Strip exports/imports from type definitions
  const strippedDefs = stripExportsAndImports(typeDefinitions);

  // Guard: combined size
  const combinedSize = strippedDefs.length + generatedProgram.length;
  if (combinedSize > MAX_COMBINED_SIZE) {
    throw new RangeError('Combined program size exceeds 256 KB limit');
  }

  // Build virtual files
  const files = new Map<string, string>();
  files.set('schema.ts', strippedDefs);
  files.set('validate.ts', generatedProgram);

  // Run tsc
  const diagnostics = checkFiles(files, ['schema.ts', 'validate.ts']);

  if (diagnostics.length === 0) {
    return { valid: true };
  }

  return {
    valid: false,
    errors: diagnostics.map(toValidationError),
  };
}
