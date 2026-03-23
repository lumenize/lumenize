/**
 * Ontology — versioned type registry with auto-extracted relationships
 *
 * Wraps the pure validate() and extractTypeMetadata() functions from
 * @lumenize/ts-runtime-validator with a type registry, versioning,
 * and auto-extracted relationship metadata.
 *
 * @see tasks/nebula-5.2.3-resources-validation-integration.md
 */

import {
  validate as rawValidate,
  extractTypeMetadata,
} from '@lumenize/ts-runtime-validator';
import type {
  ValidationResult,
  Relationship,
  TypeMetadata,
} from '@lumenize/ts-runtime-validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OntologyVersionConfig {
  version: string;
  types: string;
  defaults?: Record<string, Record<string, any>>;
  migrate?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Ontology Class
// ---------------------------------------------------------------------------

export class Ontology {
  #latestVersion: string;
  #latestDefaults: Record<string, Record<string, any>>;
  #metadata: TypeMetadata;

  constructor(versions: OntologyVersionConfig[]) {
    if (versions.length === 0) {
      throw new Error('Ontology requires at least one version');
    }

    const latest = versions[versions.length - 1];
    this.#latestVersion = latest.version;
    this.#latestDefaults = latest.defaults ?? {};

    // Extract relationships and write-shape type definitions from the latest version.
    // Uses ts.createSourceFile() — fast parse, no type-checking.
    // Throws SyntaxError on parse errors (missing braces, invalid syntax).
    this.#metadata = extractTypeMetadata(latest.types);
  }

  /** Latest version label from the versioned array */
  get latestVersion(): string {
    return this.#latestVersion;
  }

  /**
   * Validate value against typeName using the latest version's write-shape type definitions.
   * Internally calls validate(value, typeName, writeShapeTypeDefinitions).
   */
  validate(value: unknown, typeName: string): ValidationResult {
    return rawValidate(value, typeName, this.#metadata.writeShapeTypeDefinitions);
  }

  /** Get defaults for a type at the latest version (null if no defaults) */
  getDefaults(typeName: string): Record<string, any> | null {
    return this.#latestDefaults[typeName] ?? null;
  }

  /** Get auto-extracted relationship metadata for query resolution */
  getRelationship(typeName: string, fieldName: string): Relationship | null {
    return this.#metadata.relationships[typeName]?.[fieldName] ?? null;
  }
}
