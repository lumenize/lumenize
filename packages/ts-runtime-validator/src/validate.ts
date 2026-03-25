/**
 * Pure validate() function — validates a JavaScript value against TypeScript
 * type definitions at runtime by running the real TypeScript compiler.
 *
 * @see tasks/nebula-5.2.2-validate.md for full design
 */

import { toTypeScript } from './to-typescript';
import { checkFiles, type DiagnosticInfo } from './engine';
import ts from '../dist/typescript.bundled.mjs';

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

function toValidationError(d: DiagnosticInfo, programLines?: string[]): ValidationError {
  let message = d.message;

  // Enrich value-source errors with context from the generated program
  if (d.line !== undefined && mapSource(d.fileName) === 'value' && programLines) {
    const lineText = programLines[d.line - 1]; // 1-based → 0-based
    if (lineText) {
      const snippet = lineText.trim().replace(/,\s*$/, '');
      const candidate = `${d.message} → ${snippet}`;
      message = candidate.length <= 120
        ? candidate
        : `${d.message} → ${snippet.slice(0, 120 - d.message.length - 4)}...`;
    }
  }

  const error: ValidationError = {
    message,
    code: d.code,
    source: mapSource(d.fileName),
  };
  if (d.line !== undefined) error.line = d.line;

  // Extract property from tsc message patterns
  let prop = extractProperty(d.message);

  // Fallback: extract property from the generated program line context
  if (prop === undefined && d.line !== undefined && mapSource(d.fileName) === 'value' && programLines) {
    const lineText = programLines[d.line - 1];
    if (lineText) {
      const keyMatch = lineText.trim().match(/^(?:"([^"]+)"|(\w+))\s*:/);
      if (keyMatch) prop = keyMatch[1] ?? keyMatch[2];
    }
  }

  if (prop !== undefined) error.property = prop;
  return error;
}

// ---------------------------------------------------------------------------
// Generic type parameter extraction for Map/Set
// ---------------------------------------------------------------------------

/**
 * Extract Map/Set generic type parameters from type definitions.
 *
 * Walks the AST starting from `typeName` and records the raw type-argument
 * text for every Map or Set property, keyed by dot-joined property path.
 *
 * Example: for `interface C { data: Map<string, string | number>; }`
 * returns `{ "data": "<string, string | number>" }`
 */
function extractGenericParams(
  typeDefinitions: string,
  typeName: string,
): Record<string, string> {
  const sourceFile = ts.createSourceFile(
    'types.ts',
    typeDefinitions,
    ts.ScriptTarget.ESNext,
    true,
  );

  // Build a lookup of interface name → members
  const interfaces = new Map<string, any[]>();
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      interfaces.set(stmt.name.text, stmt.members);
    }
  }

  // Also check type aliases that resolve to object literals
  for (const stmt of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) {
      interfaces.set(stmt.name.text, stmt.type.members);
    }
  }

  const result: Record<string, string> = {};

  function walkMembers(members: any[], pathPrefix: string, visited: Set<string>) {
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (!ts.isIdentifier(member.name)) continue;

      const fieldName = member.name.text;
      const fullPath = pathPrefix ? `${pathPrefix}.${fieldName}` : fieldName;

      walkTypeNode(member.type, fullPath, visited);
    }
  }

  function walkTypeNode(typeNode: any, fullPath: string, visited: Set<string>) {
    // Map<K, V> or Set<V> — type reference with type arguments
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
      const refName = typeNode.typeName.text;

      if ((refName === 'Map' || refName === 'Set') && typeNode.typeArguments?.length) {
        // Extract the raw text of the type arguments including angle brackets
        const argsStart = typeNode.typeArguments[0].getStart(sourceFile);
        const argsEnd = typeNode.typeArguments[typeNode.typeArguments.length - 1].getEnd();
        const argsText = typeDefinitions.slice(argsStart, argsEnd);
        result[fullPath] = `<${argsText}>`;
        return;
      }

      // Recurse into referenced interface (for nested objects)
      if (interfaces.has(refName) && !visited.has(refName)) {
        visited.add(refName);
        walkMembers(interfaces.get(refName)!, fullPath, visited);
        visited.delete(refName);
      }
      return;
    }

    // T[] or Array<T> — recurse into element type (arrays don't change the path)
    if (ts.isArrayTypeNode(typeNode)) {
      walkTypeNode(typeNode.elementType, fullPath, visited);
      return;
    }
    if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === 'Array' && typeNode.typeArguments?.length === 1) {
      walkTypeNode(typeNode.typeArguments[0], fullPath, visited);
      return;
    }

    // Union types — check each branch
    if (ts.isUnionTypeNode(typeNode)) {
      for (const branch of typeNode.types) {
        walkTypeNode(branch, fullPath, visited);
      }
      return;
    }

    // Inline object literal type — recurse into members
    if (ts.isTypeLiteralNode(typeNode)) {
      walkMembers(typeNode.members, fullPath, visited);
    }
  }

  const rootMembers = interfaces.get(typeName);
  if (rootMembers) {
    walkMembers(rootMembers, '', new Set([typeName]));
  }

  return result;
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

  // Strip exports/imports from type definitions
  const strippedDefs = stripExportsAndImports(typeDefinitions);

  // Extract Map/Set generic type params from the type definitions
  const genericParams = extractGenericParams(strippedDefs, typeName);

  // Generate the TypeScript program from the value
  const generatedProgram = toTypeScript(value, typeName, genericParams);

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

  const programLines = generatedProgram.split('\n');
  return {
    valid: false,
    errors: diagnostics.map(d => toValidationError(d, programLines)),
  };
}
