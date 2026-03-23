/**
 * Extract type metadata from TypeScript interface definitions using AST parsing.
 *
 * Performs a single AST walk to:
 * 1. Discover relationships between interfaces (T → one, T[] → many, T? → optional)
 * 2. Generate write-shape type definitions (relationship refs → string/string[])
 *
 * Uses ts.createSourceFile() — fast parse, no type-checking needed.
 *
 * @see tasks/nebula-5.2.3-resources-validation-integration.md
 */

// Use the esbuild-bundled typescript (--platform=browser strips node:os etc.)
// so this module works in Node.js, Workers, and vitest-pool-workers.
import ts from '../dist/typescript.bundled.mjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Relationship {
  target: string;
  cardinality: 'one' | 'many';
  optional: boolean;
}

export interface TypeMetadata {
  /** typeName → fieldName → Relationship */
  relationships: Record<string, Record<string, Relationship>>;
  /** All interfaces with relationship refs replaced with string/string[].
   *  Passed as the `typeDefinitions` parameter to validate(). */
  writeShapeTypeDefinitions: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all top-level interface names from the source file */
function collectInterfaceNames(sourceFile: any): Set<string> {

  const names = new Set<string>();
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt)) {
      names.add(stmt.name.text);
    }
  }
  return names;
}

/**
 * Analyze a property's type node to determine if it references an ontology type.
 * Returns the relationship info if it does, or null if it's a regular field.
 */
function analyzeTypeNode(
  typeNode: any,
  ontologyTypes: Set<string>,
  isOptionalProperty: boolean,
): Relationship | null {


  // T[] — Array<T> syntax
  if (ts.isArrayTypeNode(typeNode)) {
    const elementType = typeNode.elementType;
    if (ts.isTypeReferenceNode(elementType) && ts.isIdentifier(elementType.typeName)) {
      const name = elementType.typeName.text;
      if (ontologyTypes.has(name)) {
        return { target: name, cardinality: 'many', optional: isOptionalProperty };
      }
    }
    return null;
  }

  // Array<T> — generic syntax
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const refName = typeNode.typeName.text;

    if (refName === 'Array' && typeNode.typeArguments?.length === 1) {
      const arg = typeNode.typeArguments[0];
      if (ts.isTypeReferenceNode(arg) && ts.isIdentifier(arg.typeName)) {
        const name = arg.typeName.text;
        if (ontologyTypes.has(name)) {
          return { target: name, cardinality: 'many', optional: isOptionalProperty };
        }
      }
      return null;
    }

    // T — direct reference
    if (ontologyTypes.has(refName)) {
      return { target: refName, cardinality: 'one', optional: isOptionalProperty };
    }
    return null;
  }

  // T | null — union with null (optional one)
  if (ts.isUnionTypeNode(typeNode)) {
    const isNullish = (t: any): boolean => {
      if (t.kind === ts.SyntaxKind.NullKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword) return true;
      if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) return true;
      return false;
    };
    const nonNullTypes = typeNode.types.filter((t: any) => !isNullish(t));
    const hasNull = nonNullTypes.length < typeNode.types.length;
    if (nonNullTypes.length === 1) {
      const inner = nonNullTypes[0];
      const result = analyzeTypeNode(inner, ontologyTypes, isOptionalProperty || hasNull);
      if (result && hasNull) {
        return { ...result, optional: true };
      }
      return result;
    }
  }

  return null;
}

/**
 * Generate the write-shape type text for a property, replacing relationship
 * refs with string/string[].
 */
function getWriteShapeType(rel: Relationship): string {
  if (rel.cardinality === 'many') {
    return 'string[]';
  }
  return 'string';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract type metadata from TypeScript interface definitions.
 *
 * Performs a single AST walk to extract relationship metadata and generate
 * write-shape type definitions (relationship refs → string/string[]).
 *
 * @param typeDefinitions - TypeScript interface definitions as a string
 * @returns TypeMetadata with relationships and writeShapeTypeDefinitions
 * @throws SyntaxError if the type definitions cannot be parsed (missing braces, invalid syntax)
 */
export function extractTypeMetadata(typeDefinitions: string): TypeMetadata {

  const sourceFile = ts.createSourceFile(
    'types.ts',
    typeDefinitions,
    ts.ScriptTarget.ESNext,
    true,
  );

  // Check for parse errors
  const parseDiags = (sourceFile as any).parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) {
    const msg = parseDiags
      .map((d: any) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new SyntaxError(`Failed to parse type definitions: ${msg}`);
  }

  const ontologyTypes = collectInterfaceNames(sourceFile);
  const relationships: Record<string, Record<string, Relationship>> = {};

  // Track replacements: { start, end, replacement } for write-shape generation
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;

    const typeName = stmt.name.text;

    for (const member of stmt.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      if (!ts.isIdentifier(member.name)) continue;

      const fieldName = member.name.text;
      const isOptional = member.questionToken !== undefined;
      const rel = analyzeTypeNode(member.type, ontologyTypes, isOptional);

      if (rel) {
        if (!relationships[typeName]) {
          relationships[typeName] = {};
        }
        relationships[typeName][fieldName] = rel;

        // Record replacement for write-shape generation
        const writeType = getWriteShapeType(rel);
        replacements.push({
          start: member.type.getStart(sourceFile),
          end: member.type.getEnd(),
          replacement: writeType,
        });
      }
    }
  }

  // Generate write-shape type definitions by applying replacements in reverse order
  let writeShape = typeDefinitions;
  replacements.sort((a, b) => b.start - a.start);
  for (const { start, end, replacement } of replacements) {
    writeShape = writeShape.slice(0, start) + replacement + writeShape.slice(end);
  }

  return {
    relationships,
    writeShapeTypeDefinitions: writeShape,
  };
}
