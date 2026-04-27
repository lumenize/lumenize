/**
 * Extract type metadata from TypeScript interface definitions via AST parsing.
 *
 * Ported from `@lumenize/ts-runtime-validator`'s `extractTypeMetadata()` and
 * **extended** with a `@default` JSDoc pass per Phase 3 decisions D2 / D3 and
 * Phase 4 decision P4.2. One AST walk does all three jobs:
 *
 * 1. **Relationship discovery** — `field: T`, `field: T[]`, `field: Array<T>`,
 *    `field: T | null` (where `T` is another interface in the same ontology)
 *    becomes a `Relationship` record. Ported from the old package as-is.
 * 2. **Write-shape generation** — relationship refs are rewritten to
 *    `string` / `string[]` in the returned `writeShapeTypeDefinitions` so
 *    the validator sees ID-shaped values at transaction time. Ported as-is.
 * 3. **`@default` extraction** — each property's JSDoc is walked via
 *    `ts.getJSDocTags()`. An `@default <json-literal>` tag pairs with an
 *    optional property to produce a `typeMetadata.defaults[TypeName][field]`
 *    entry. An `@default` on a required property throws at extract time with
 *    a corrective message (Phase 4 P4.2).
 *
 * Uses `ts.createSourceFile()` via the shared bundled `typescript` instance
 * from `dist/deps.bundle.mjs`, so it runs inside a Workers isolate without
 * a second `ts` instance leaking in (typia's transformer does `instanceof
 * ts.Node` checks that silently fail with two instances — keep them aligned).
 *
 * This function is **internal** to the package — `generateParseModule()`
 * calls it and bakes the metadata into the emitted module. Not re-exported
 * from `src/index.ts`.
 */

// @ts-expect-error — pre-bundled deps, no types; see scripts/bundle-dependencies.mjs
import { ts } from '../dist/deps.bundle.mjs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Relationship {
  target: string;
  cardinality: 'one' | 'many';
  optional: boolean;
  /**
   * Container shape captured for write-shape rewriting and, eventually, for
   * the runtime filler. `undefined` means the field is a single reference
   * (`T` or `T | null`). `array` means `T[]` / `Array<T>`. `set` / `readonlyset`
   * mean `Set<T>` / `ReadonlySet<T>`. `map` / `readonlymap` mean `Map<K, T>` /
   * `ReadonlyMap<K, T>` — for these, `mapKeyType` preserves K's source text.
   */
  container?: 'array' | 'set' | 'readonlyset' | 'map' | 'readonlymap';
  /** Original source text of the Map's K type, preserved for write-shape. */
  mapKeyType?: string;
}

/**
 * Defaults map: outer key = type name (the interface the field belongs to),
 * inner key = field name, value = the JSON literal parsed from `@default`.
 *
 * Values are any JSON-literal shape per Phase 3 D3: number, string, boolean,
 * null, JSON array, or plain JSON object. Nested JSON is permitted.
 */
export type DefaultsMap = Record<string, Record<string, unknown>>;

/**
 * Per-field inline-subtype record. Populated when a field's declared type
 * contains an anonymous inline type literal — directly (`field?: {...}`),
 * inside one or more containers (`field?: Array<{...}>`, `Array<Array<{...}>>`,
 * `Set<{...}>`, `Map<K, {...}>`, and the `Readonly` variants; containers
 * nest arbitrarily deep), wrapped in a nullable union (`field?: {...} | null`),
 * or a discriminated union of inline types (`field?: { kind: 'a'; ... } | { kind: 'b'; ... }`).
 *
 * **Direct / container-wrapped case**: `subTypeName` + optional `containers`
 * point at a single sub-type. The filler walks straight in.
 *
 * **Discriminated-union case**: `discriminator` carries the field name plus a
 * map from each variant's literal-discriminator value to the synthesized
 * sub-type for that variant. The filler reads the discriminator at runtime
 * and routes into the matching sub-type.
 *
 * Exactly one of `subTypeName` or `discriminator` is populated.
 */
export interface InlineSubtype {
  /** Present for direct or container-wrapped inline types. */
  subTypeName?: string;
  /**
   * Outer-to-inner container chain. Empty (or omitted) for a direct inline
   * type (`field?: {...}`). For `Array<Array<{...}>>`, `['array', 'array']`.
   * For `Map<string, Array<{...}>>`, `['map', 'array']`. Only meaningful
   * when `subTypeName` is set.
   */
  containers?: Array<'array' | 'set' | 'readonlyset' | 'map' | 'readonlymap'>;
  /**
   * Same-length array aligning with `containers`. Non-undefined entries carry
   * the Map/ReadonlyMap's K source text at the matching position; undefined at
   * non-Map positions. Preserved for potential future use.
   */
  mapKeyTypes?: Array<string | undefined>;
  /**
   * Present for a discriminated-union inline type. `field` is the shared
   * literal-typed property across variants; `variants` maps each literal
   * discriminator value (stringified) to its synthesized sub-type name.
   */
  discriminator?: {
    field: string;
    variants: Record<string, string>;
  };
}

export interface TypeMetadata {
  /** Top-level interface names in declaration order. */
  interfaceNames: string[];
  /** `typeName -> fieldName -> Relationship`. */
  relationships: Record<string, Record<string, Relationship>>;
  /**
   * All interfaces with relationship refs replaced with `string` / `string[]`.
   * Passed as the `typeDefinitions` parameter to the typia compile step.
   */
  writeShapeTypeDefinitions: string;
  /**
   * `typeName -> fieldName -> JSON-literal default value`. Keys include both
   * top-level interface names and synthesized sub-type names for anonymous
   * inline type literals (e.g. `"Config/server/retries"`).
   */
  defaults: DefaultsMap;
  /**
   * `parentTypeName -> fieldName -> InlineSubtype`. The filler walks into
   * these sub-types the same way it walks into named interfaces, so nested
   * `@default` tags apply recursively through inline shapes — matching the
   * "just use TypeScript" ergonomics.
   */
  inlineSubtypes: Record<string, Record<string, InlineSubtype>>;
}

// ---------------------------------------------------------------------------
// Internal helpers — ported from ts-runtime-validator
// ---------------------------------------------------------------------------

const tsApi = ts as {
  createSourceFile: Function;
  ScriptTarget: { Latest: number };
  isInterfaceDeclaration: Function;
  isTypeAliasDeclaration: Function;
  isPropertySignature: Function;
  isIdentifier: Function;
  isArrayTypeNode: Function;
  isTypeReferenceNode: Function;
  isUnionTypeNode: Function;
  isLiteralTypeNode: Function;
  isTypeLiteralNode: Function;
  getJSDocTags: Function;
  flattenDiagnosticMessageText: Function;
  SyntaxKind: { NullKeyword: number; UndefinedKeyword: number; TrueKeyword: number; FalseKeyword: number };
};

function collectInterfaceNamesArray(sourceFile: any): string[] {
  const names: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (tsApi.isInterfaceDeclaration(stmt)) {
      names.push(stmt.name.text);
    }
  }
  return names;
}

/**
 * Collect top-level `type X = Y;` or `type X = Y<...>;` aliases where `Y` is
 * itself a top-level interface in the same source. Returns the alias name
 * plus the target interface name. Aliases to non-interface targets (inline
 * type literals, union types, primitives, etc.) are skipped — typia still
 * validates them fine if the name is added to `interfaceNames`, but there's
 * no named metadata target to copy from.
 */
function collectTypeAliases(
  sourceFile: any,
  ontologyTypes: Set<string>,
): Array<{ name: string; targetInterface: string | null }> {
  const out: Array<{ name: string; targetInterface: string | null }> = [];
  for (const stmt of sourceFile.statements) {
    if (!tsApi.isTypeAliasDeclaration(stmt)) continue;
    if (!tsApi.isIdentifier(stmt.name)) continue;
    const aliasName = stmt.name.text;
    let target: string | null = null;
    // `type X = Y<...>` or `type X = Y` — resolve Y if it's a known interface.
    if (tsApi.isTypeReferenceNode(stmt.type) && tsApi.isIdentifier(stmt.type.typeName)) {
      const refName = stmt.type.typeName.text;
      if (ontologyTypes.has(refName)) target = refName;
    }
    out.push({ name: aliasName, targetInterface: target });
  }
  return out;
}

/**
 * If `arg` is a bare reference to an ontology type, return its name; else null.
 */
function ontologyRefName(arg: any, ontologyTypes: Set<string>): string | null {
  if (tsApi.isTypeReferenceNode(arg) && tsApi.isIdentifier(arg.typeName)) {
    const name = arg.typeName.text;
    if (ontologyTypes.has(name)) return name;
  }
  return null;
}

function analyzeTypeNode(
  typeNode: any,
  ontologyTypes: Set<string>,
  isOptionalProperty: boolean,
  sourceFile: any,
): Relationship | null {
  // T[]
  if (tsApi.isArrayTypeNode(typeNode)) {
    const name = ontologyRefName(typeNode.elementType, ontologyTypes);
    if (name) {
      return {
        target: name,
        cardinality: 'many',
        optional: isOptionalProperty,
        container: 'array',
      };
    }
    return null;
  }
  // Generic references: Array<T>, Set<T>, ReadonlySet<T>, Map<K, T>, ReadonlyMap<K, T>, or T
  if (tsApi.isTypeReferenceNode(typeNode) && tsApi.isIdentifier(typeNode.typeName)) {
    const refName = typeNode.typeName.text;
    const typeArgs = typeNode.typeArguments;

    // Array<T>, Set<T>, ReadonlySet<T> — single type arg; T must be ontology
    if (
      (refName === 'Array' || refName === 'Set' || refName === 'ReadonlySet') &&
      typeArgs?.length === 1
    ) {
      const name = ontologyRefName(typeArgs[0], ontologyTypes);
      if (name) {
        return {
          target: name,
          cardinality: 'many',
          optional: isOptionalProperty,
          container:
            refName === 'Array' ? 'array' : refName === 'Set' ? 'set' : 'readonlyset',
        };
      }
      return null;
    }

    // Map<K, V>, ReadonlyMap<K, V> — value arg must be ontology; key is preserved as source
    if ((refName === 'Map' || refName === 'ReadonlyMap') && typeArgs?.length === 2) {
      const valueName = ontologyRefName(typeArgs[1], ontologyTypes);
      if (valueName) {
        return {
          target: valueName,
          cardinality: 'many',
          optional: isOptionalProperty,
          container: refName === 'Map' ? 'map' : 'readonlymap',
          mapKeyType: typeArgs[0].getText(sourceFile),
        };
      }
      return null;
    }

    // Bare T — direct one-to-one reference
    if (ontologyTypes.has(refName)) {
      return { target: refName, cardinality: 'one', optional: isOptionalProperty };
    }
    return null;
  }
  // T | null  (optional one)
  if (tsApi.isUnionTypeNode(typeNode)) {
    const isNullish = (t: any): boolean => {
      if (t.kind === tsApi.SyntaxKind.NullKeyword || t.kind === tsApi.SyntaxKind.UndefinedKeyword) return true;
      if (tsApi.isLiteralTypeNode(t) && t.literal.kind === tsApi.SyntaxKind.NullKeyword) return true;
      return false;
    };
    const nonNullTypes = typeNode.types.filter((t: any) => !isNullish(t));
    const hasNull = nonNullTypes.length < typeNode.types.length;
    if (nonNullTypes.length === 1) {
      const inner = nonNullTypes[0];
      const result = analyzeTypeNode(inner, ontologyTypes, isOptionalProperty || hasNull, sourceFile);
      if (result && hasNull) return { ...result, optional: true };
      return result;
    }
  }
  return null;
}

/**
 * Find an anonymous inline type literal inside a type node. Handles direct
 * (`{...}`), arbitrarily-nested container-wrapped (`Array<{...}>`, `T[]`,
 * `Set<{...}>`, `ReadonlySet<{...}>`, `Map<K, {...}>`, `ReadonlyMap<K, {...}>`
 * — and combinations: `Array<Array<{...}>>`, `Map<K, Array<{...}>>`, etc.),
 * and nullable-union-wrapped (`{...} | null`) cases. Returns the inner literal
 * plus an outer-to-inner chain of container metadata, or null if no inline
 * literal is reachable.
 */
type ContainerKind = NonNullable<InlineSubtype['containers']>[number];
function findInlineTypeLiteral(
  typeNode: any,
  sourceFile: any,
): { literal: any; containers: ContainerKind[]; mapKeyTypes: Array<string | undefined> } | null {
  // Direct inline: { ... }
  if (tsApi.isTypeLiteralNode(typeNode)) {
    return { literal: typeNode, containers: [], mapKeyTypes: [] };
  }
  // T[] — recurse into the element
  if (tsApi.isArrayTypeNode(typeNode)) {
    const inner = findInlineTypeLiteral(typeNode.elementType, sourceFile);
    if (inner) {
      return {
        literal: inner.literal,
        containers: ['array', ...inner.containers],
        mapKeyTypes: [undefined, ...inner.mapKeyTypes],
      };
    }
    return null;
  }
  // Generic: Array<T>, Set<T>, ReadonlySet<T>, Map<K, T>, ReadonlyMap<K, T>
  if (tsApi.isTypeReferenceNode(typeNode) && tsApi.isIdentifier(typeNode.typeName)) {
    const refName = typeNode.typeName.text;
    const typeArgs = typeNode.typeArguments;
    if (
      (refName === 'Array' || refName === 'Set' || refName === 'ReadonlySet') &&
      typeArgs?.length === 1
    ) {
      const inner = findInlineTypeLiteral(typeArgs[0], sourceFile);
      if (inner) {
        const container: ContainerKind =
          refName === 'Array' ? 'array' : refName === 'Set' ? 'set' : 'readonlyset';
        return {
          literal: inner.literal,
          containers: [container, ...inner.containers],
          mapKeyTypes: [undefined, ...inner.mapKeyTypes],
        };
      }
      return null;
    }
    if ((refName === 'Map' || refName === 'ReadonlyMap') && typeArgs?.length === 2) {
      const inner = findInlineTypeLiteral(typeArgs[1], sourceFile);
      if (inner) {
        const container: ContainerKind = refName === 'Map' ? 'map' : 'readonlymap';
        return {
          literal: inner.literal,
          containers: [container, ...inner.containers],
          mapKeyTypes: [typeArgs[0].getText(sourceFile), ...inner.mapKeyTypes],
        };
      }
      return null;
    }
  }
  // T | null | undefined — unwrap and recurse
  if (tsApi.isUnionTypeNode(typeNode)) {
    const isNullish = (t: any): boolean => {
      if (t.kind === tsApi.SyntaxKind.NullKeyword || t.kind === tsApi.SyntaxKind.UndefinedKeyword) return true;
      if (tsApi.isLiteralTypeNode(t) && t.literal.kind === tsApi.SyntaxKind.NullKeyword) return true;
      return false;
    };
    const nonNullTypes = typeNode.types.filter((t: any) => !isNullish(t));
    if (nonNullTypes.length === 1) {
      return findInlineTypeLiteral(nonNullTypes[0], sourceFile);
    }
    // Multi-shape unions are handled separately by `findDiscriminatedUnion`.
  }
  return null;
}

/**
 * Detect a discriminated union of inline type literals and return the
 * discriminator field + per-variant TypeLiteralNode map, keyed by the
 * stringified literal value. Null/undefined members are ignored.
 *
 * A union qualifies when:
 * - It has ≥ 2 non-null TypeLiteralNode members (all must be inline literals).
 * - Some property name is present on every member with a LiteralTypeNode type.
 * - Each variant's literal value (string / number / `true` / `false`) is
 *   distinct from the others — so the runtime discriminator lookup is unambiguous.
 *
 * Returns the first qualifying field (by insertion order in the first variant)
 * if multiple fields meet the criteria. Returns null for non-unions, single-
 * variant unions, or unions that don't share a clean discriminator.
 */
function findDiscriminatedUnion(
  typeNode: any,
): { field: string; variants: Array<{ value: string; literal: any }> } | null {
  if (!tsApi.isUnionTypeNode(typeNode)) return null;
  const isNullish = (t: any): boolean => {
    if (t.kind === tsApi.SyntaxKind.NullKeyword || t.kind === tsApi.SyntaxKind.UndefinedKeyword) return true;
    if (tsApi.isLiteralTypeNode(t) && t.literal.kind === tsApi.SyntaxKind.NullKeyword) return true;
    return false;
  };
  const members: any[] = typeNode.types.filter((t: any) => !isNullish(t));
  if (members.length < 2) return null;
  if (!members.every((m: any) => tsApi.isTypeLiteralNode(m))) return null;

  // Collect each member's literal-typed fields: name → stringified literal value
  const literalFieldsPerMember: Array<Map<string, string>> = members.map((m: any) => {
    const out = new Map<string, string>();
    for (const prop of m.members) {
      if (!tsApi.isPropertySignature(prop) || !tsApi.isIdentifier(prop.name) || !prop.type) continue;
      if (!tsApi.isLiteralTypeNode(prop.type)) continue;
      const lit = prop.type.literal;
      // Support string / number literals and `true` / `false` keyword nodes.
      let value: string | null = null;
      if (typeof lit.text === 'string') {
        // StringLiteral (text is the raw content without quotes) or NumericLiteral.
        value = lit.text;
      } else if (lit.kind === tsApi.SyntaxKind.TrueKeyword) {
        value = 'true';
      } else if (lit.kind === tsApi.SyntaxKind.FalseKeyword) {
        value = 'false';
      }
      if (value !== null) out.set(prop.name.text, value);
    }
    return out;
  });

  // Find a field name present in all members with distinct values.
  const firstMemberFields = literalFieldsPerMember[0];
  if (!firstMemberFields) return null;
  for (const [fieldName] of firstMemberFields) {
    const values: string[] = [];
    let ok = true;
    for (const fields of literalFieldsPerMember) {
      const v = fields.get(fieldName);
      if (v === undefined) { ok = false; break; }
      values.push(v);
    }
    if (!ok) continue;
    if (new Set(values).size !== values.length) continue; // duplicates — not distinct
    return {
      field: fieldName,
      variants: members.map((m: any, i: number) => ({
        value: values[i]!,
        literal: m,
      })),
    };
  }
  return null;
}

/**
 * Produce the write-shape TypeScript text for a relationship. The ontology
 * type argument becomes `string`; the container shape (Array / Set / Map) is
 * preserved so typia validates against the right runtime container.
 */
function getWriteShapeType(rel: Relationship): string {
  if (rel.cardinality === 'one') return 'string';
  switch (rel.container) {
    case 'set':
      return 'Set<string>';
    case 'readonlyset':
      return 'ReadonlySet<string>';
    case 'map':
      return `Map<${rel.mapKeyType ?? 'string'}, string>`;
    case 'readonlymap':
      return `ReadonlyMap<${rel.mapKeyType ?? 'string'}, string>`;
    case 'array':
    default:
      return 'string[]';
  }
}

// ---------------------------------------------------------------------------
// @default JSDoc extraction
// ---------------------------------------------------------------------------

/**
 * Read the plain-text comment of a `@default` tag. TypeScript stores JSDoc
 * comment content in one of two shapes (string, or array of comment parts)
 * depending on the TS version; normalise here.
 */
function getTagText(tag: any): string {
  if (tag.comment === undefined || tag.comment === null) return '';
  if (typeof tag.comment === 'string') return tag.comment;
  if (Array.isArray(tag.comment)) {
    return tag.comment.map((part: any) => (typeof part === 'string' ? part : part.text ?? '')).join('');
  }
  return String(tag.comment);
}

/**
 * Parse a `@default` tag value per Phase 3 D3: JSON literals only.
 * Throws a user-visible error with typeName + fieldName + offending text
 * if the value doesn't round-trip through `JSON.parse`.
 */
function parseDefaultLiteral(rawText: string, typeName: string, fieldName: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error(
      `@lumenize/ts-runtime-parser-validator: empty @default value on ${typeName}.${fieldName} — ` +
        `provide a JSON literal (number, string, boolean, null, array, or object).`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `@lumenize/ts-runtime-parser-validator: invalid @default value on ${typeName}.${fieldName} — ` +
        `expected a JSON literal, got \`${trimmed}\` (${reason}). ` +
        `Accepted: numbers, double-quoted strings, true/false/null, JSON arrays, JSON objects. ` +
        `Rejected: bigint (\`10n\`), NaN, Infinity, undefined, single-quoted strings, unquoted object keys.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a string of TypeScript interface definitions and extract:
 *   - relationships between interfaces
 *   - a write-shape version of the source with relationship fields narrowed to string/string[]
 *   - default values collected from `@default` JSDoc tags on optional fields
 *
 * @param typeDefinitions - TypeScript interface definitions as a string
 * @returns `TypeMetadata` — consumed by `generateParseModule()`
 * @throws if parsing fails, if `@default` is on a required field, or if the
 *   `@default` value is not a valid JSON literal
 */
export function extractTypeMetadata(typeDefinitions: string): TypeMetadata {
  const sourceFile = tsApi.createSourceFile(
    'types.ts',
    typeDefinitions,
    tsApi.ScriptTarget.Latest,
    true,
  );

  const parseDiags = (sourceFile as any).parseDiagnostics;
  if (parseDiags && parseDiags.length > 0) {
    const msg = parseDiags
      .map((d: any) => tsApi.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('; ');
    throw new SyntaxError(`Failed to parse type definitions: ${msg}`);
  }

  const interfaceNames = collectInterfaceNamesArray(sourceFile);
  const ontologyTypes = new Set(interfaceNames);
  const relationships: Record<string, Record<string, Relationship>> = {};
  const defaults: DefaultsMap = {};
  const inlineSubtypes: Record<string, Record<string, InlineSubtype>> = {};
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  /**
   * Walk the members of an interface body or an anonymous inline type
   * literal. `typeName` is either a real top-level interface name or a
   * synthesized path-based name (e.g. `"Config/server"`). `isTopLevel`
   * gates relationship/write-shape handling, which applies only to
   * top-level interface members.
   */
  function walkMembers(members: any, typeName: string, isTopLevel: boolean) {
    for (const member of members) {
      if (!tsApi.isPropertySignature(member) || !member.type) continue;
      if (!tsApi.isIdentifier(member.name)) continue;

      const fieldName = member.name.text;
      const isOptional = member.questionToken !== undefined;

      // Relationship pass — analyse at every level so the filler can recurse
      // into named-interface refs even when they're nested inside inline type
      // literals. WriteShape replacements, however, apply only at the top
      // level (the composer pattern rewrites top-level interface members;
      // inline shapes are left alone).
      const rel = analyzeTypeNode(member.type, ontologyTypes, isOptional, sourceFile);
      if (rel) {
        if (!relationships[typeName]) relationships[typeName] = {};
        relationships[typeName][fieldName] = rel;
        if (isTopLevel) {
          replacements.push({
            start: member.type.getStart(sourceFile),
            end: member.type.getEnd(),
            replacement: getWriteShapeType(rel),
          });
        }
      }

      // @default pass
      const jsDocTags: any[] = tsApi.getJSDocTags(member) ?? [];
      for (const tag of jsDocTags) {
        if (tag.tagName?.text !== 'default') continue;
        if (!isOptional) {
          throw new Error(
            `@lumenize/ts-runtime-parser-validator: @default on required field '${typeName}.${fieldName}' — ` +
              `declare the field optional (${fieldName}?: ...) or remove the @default tag.`,
          );
        }
        const rawText = getTagText(tag);
        const parsed = parseDefaultLiteral(rawText, typeName, fieldName);
        if (!defaults[typeName]) defaults[typeName] = {};
        defaults[typeName][fieldName] = parsed;
        // Multiple `@default` tags → last wins (matches JSDoc iteration order).
      }

      // Inline type literal recursion. Covers direct (`field?: { ... }`),
      // container-wrapped (`Array<{...}>` / `T[]` / `Set<{...}>` / `Map<K, {...}>`
      // and the Readonly variants — nested arbitrarily, e.g. `Array<Array<{...}>>`),
      // and nullable-union-wrapped (`{...} | null`). Synthesises a sub-type named
      // `${typeName}/${fieldName}` so nested @default tags attach there and the
      // filler can recurse through the container chain.
      const inlineInfo = findInlineTypeLiteral(member.type, sourceFile);
      if (inlineInfo) {
        const subTypeName = `${typeName}/${fieldName}`;
        if (!inlineSubtypes[typeName]) inlineSubtypes[typeName] = {};
        const entry: InlineSubtype = { subTypeName };
        if (inlineInfo.containers.length > 0) {
          entry.containers = inlineInfo.containers;
          entry.mapKeyTypes = inlineInfo.mapKeyTypes;
        }
        inlineSubtypes[typeName][fieldName] = entry;
        walkMembers(inlineInfo.literal.members, subTypeName, /* isTopLevel */ false);
      } else {
        // Discriminated union of inline type literals:
        // `field?: { kind: 'a'; ... } | { kind: 'b'; ... }`. Synthesise one
        // sub-type per variant, record the discriminator + variant map so the
        // filler can route by reading the discriminator value at runtime.
        const disc = findDiscriminatedUnion(member.type);
        if (disc) {
          const variants: Record<string, string> = {};
          for (const { value, literal } of disc.variants) {
            const variantSubTypeName = `${typeName}/${fieldName}/${value}`;
            variants[value] = variantSubTypeName;
            walkMembers(literal.members, variantSubTypeName, /* isTopLevel */ false);
          }
          if (!inlineSubtypes[typeName]) inlineSubtypes[typeName] = {};
          inlineSubtypes[typeName][fieldName] = {
            discriminator: { field: disc.field, variants },
          };
        }
      }
    }
  }

  for (const stmt of sourceFile.statements) {
    if (!tsApi.isInterfaceDeclaration(stmt)) continue;
    walkMembers(stmt.members, stmt.name.text, /* isTopLevel */ true);
  }

  // Register top-level `type X = Y` / `type X = Y<...>` aliases. typia's
  // transform resolves aliases structurally, so adding the alias to
  // `interfaceNames` is enough for validation. For `@default` / relationship
  // metadata the extractor copies the target interface's entries under the
  // alias name so the filler sees them when parsing by the alias.
  const aliases = collectTypeAliases(sourceFile, ontologyTypes);
  for (const { name: aliasName, targetInterface } of aliases) {
    interfaceNames.push(aliasName);
    if (targetInterface) {
      if (defaults[targetInterface]) defaults[aliasName] = defaults[targetInterface];
      if (relationships[targetInterface]) relationships[aliasName] = relationships[targetInterface];
      if (inlineSubtypes[targetInterface]) inlineSubtypes[aliasName] = inlineSubtypes[targetInterface];
    }
  }

  // Apply write-shape replacements in reverse source order
  let writeShape = typeDefinitions;
  replacements.sort((a, b) => b.start - a.start);
  for (const { start, end, replacement } of replacements) {
    writeShape = writeShape.slice(0, start) + replacement + writeShape.slice(end);
  }

  return {
    interfaceNames,
    relationships,
    writeShapeTypeDefinitions: writeShape,
    defaults,
    inlineSubtypes,
  };
}
