import type { Tool } from './tool-registry';
import { EntityTypeAlreadyExistsError, ParameterValidationError } from './errors';
import { Schema as JSONSchema } from '@cfworker/json-schema';

export interface EntityTypeDefinition {
  name: string; // The name of the entity type, must follow the naming rules
  version: number; // Version number (integer) of the entity type
  jsonSchema: JSONSchema; // The JSON schema defining the entity type
  description?: string; // Optional description of the entity type
}

export class EntityTypes {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    
    // Create the entity_types table if it doesn't exist
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS entity_types (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        jsonSchema TEXT NOT NULL,
        description TEXT,
        PRIMARY KEY (name, version)
      )
    `);
  }

  #validateEntityTypeName(name: string): void {
    if (!name) {
      throw new ParameterValidationError(`EntityTypeDefinition.name cannot be empty`);
    }
    
    if (!/^[a-z0-9_-]+$/.test(name)) {
      throw new ParameterValidationError('EntityTypeDefinition.name must contain only lowercase letters, digits, hyphens (-), and underscores (_)');
    }
  }

  #validateEntityTypeVersion(version: number): void {
    if (!Number.isInteger(version) || version < 1) {
      throw new ParameterValidationError('EntityTypeDefinition.version must be a positive integer');
    }
  }

  getEntityTypeDefinition(name: string, version: number): EntityTypeDefinition | undefined {
    this.#validateEntityTypeName(name);
    this.#validateEntityTypeVersion(version);
    
    const result = this.#storage.sql.exec(`
      SELECT name, version, jsonSchema, description 
      FROM entity_types 
      WHERE name = ? AND version = ?
    `, name, version);
    
    for (const row of result) {
      const definition: EntityTypeDefinition = {
        name: row.name as string,
        version: row.version as number,
        jsonSchema: JSON.parse(row.jsonSchema as string)
      };
      
      if (row.description) {
        definition.description = row.description as string;
      }
      
      return definition;
    }
    
    return undefined;
  }

  addEntityTypeDefinition(definition: EntityTypeDefinition): void {
    if (!definition || typeof definition !== 'object') {
      throw new ParameterValidationError("EntityTypeDefinition must be an object");
    }
    this.#validateEntityTypeName(definition.name);
    this.#validateEntityTypeVersion(definition.version);
    if (!definition.jsonSchema || typeof definition.jsonSchema !== 'object') {
      throw new ParameterValidationError("EntityTypeDefinition.jsonSchema cannot be empty and must be an object");
    }
    
    // Check for existing schema with the same name and version
    const existing = this.getEntityTypeDefinition(definition.name, definition.version);
    if (existing) {
      throw new EntityTypeAlreadyExistsError(`EntityTypeDefinition with name '${definition.name}' and version '${definition.version}' already exists`);
    }
    
    // Insert the new entity type definition
    this.#storage.sql.exec(`
      INSERT INTO entity_types (name, version, jsonSchema, description)
      VALUES (?, ?, ?, ?)
    `, definition.name, definition.version, JSON.stringify(definition.jsonSchema), definition.description || null);
  }

  getLatestEntityTypeDefinition(name: string): EntityTypeDefinition | undefined {
    this.#validateEntityTypeName(name);
    
    const result = this.#storage.sql.exec(`
      SELECT name, version, jsonSchema, description 
      FROM entity_types 
      WHERE name = ? 
      ORDER BY version DESC 
      LIMIT 1
    `, name);
    
    for (const row of result) {
      const definition: EntityTypeDefinition = {
        name: row.name as string,
        version: row.version as number,
        jsonSchema: JSON.parse(row.jsonSchema as string)
      };
      
      if (row.description) {
        definition.description = row.description as string;
      }
      
      return definition;
    }
    
    return undefined;
  }

  listEntityTypeDefinitions(): EntityTypeDefinition[] {
    const entityTypes: EntityTypeDefinition[] = [];
    
    const result = this.#storage.sql.exec(`
      SELECT name, version, jsonSchema, description 
      FROM entity_types 
      ORDER BY name, version
    `);
    
    for (const row of result) {
      const definition: EntityTypeDefinition = {
        name: row.name as string,
        version: row.version as number,
        jsonSchema: JSON.parse(row.jsonSchema as string)
      };
      
      if (row.description) {
        definition.description = row.description as string;
      }
      
      entityTypes.push(definition);
    }
    
    return entityTypes;
  }

  static readonly addEntityTypeTool: Omit<Tool, 'handler'> = {  // handler is added in the instance with createTool()
    name: 'add-entity-type',
    description: 'Add a new entity type definition to the registry',
    inputSchema: {
      type: 'object',
      properties: {
        name: { 
          type: 'string', 
          description: 'The name of the entity type (lowercase letters, digits, hyphens, underscores only)' 
        },
        version: { 
          type: 'integer', 
          minimum: 1,
          description: 'The version number of the entity type (positive integer)' 
        },
        jsonSchema: { 
          type: 'object', 
          description: 'The JSON schema defining the entity type structure' 
        },
        description: { 
          type: 'string', 
          description: 'Optional description of the entity type' 
        }
      },
      required: ['name', 'version', 'jsonSchema']
    },
    outputSchema: {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the entity type was successfully added' },
        message: { type: 'string', description: 'Success or error message' }
      },
      required: ['success', 'message']
    },
    annotations: {
      title: 'Add Entity Type',
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
  };

  createTool(): Tool {
    return {
      ...EntityTypes.addEntityTypeTool,
      handler: (args) => {
        const { name, version, jsonSchema, description } = args ?? {};
        
        // Validate name format (MCP input schema validates presence/type, but not format)
        if (!/^[a-z0-9_-]+$/.test(name)) {
          throw new ParameterValidationError('name must contain only lowercase letters, digits, hyphens, and underscores');
        }
        
        // Validate version format (MCP input schema validates presence/type, but not format)
        if (!/^[a-z0-9_.-]+$/.test(version)) {
          throw new ParameterValidationError('version must contain only lowercase letters, digits, hyphens, underscores, and periods');
        }

        const definition: EntityTypeDefinition = {
          name,
          version,
          jsonSchema,
          ...(description && { description })
        };
        
        // Let custom errors from this.addEntityTypeDefinition() propagate directly
        this.addEntityTypeDefinition(definition);
        
        return {
          success: true,
          message: `Entity type '${name}' version '${version}' added successfully`
        };
      }
    };
  }
}
