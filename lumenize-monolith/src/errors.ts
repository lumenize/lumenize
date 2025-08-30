/**
 * Custom error classes for tool execution and validation
 * These provide more robust error handling than string matching
 */

/**
 * Thrown when tool input parameters are invalid
 */
export class ParameterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParameterValidationError';
  }
}

/**
 * Thrown when a requested tool is not found
 */
export class ToolNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolNotFoundError';
  }
}

/**
 * Thrown when tool execution fails due to internal errors
 */
export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * Thrown when trying to create an entity that already exists
 */
export class EntityTypeAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityTypeAlreadyExistsError';
  }
}

/**
 * Entity-related errors organized by level:
 * - Schema level: EntityTypeNotFoundError (entity type/schema definition doesn't exist)
 * - Instance level: EntityNotFoundError (entity instance doesn't exist)
 * - Version level: SnapshotNotFoundError (specific snapshot/version doesn't exist)
 */

/**
 * Thrown when a required entity type definition is not found (Schema level)
 */
export class EntityTypeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityTypeNotFoundError';
  }
}

/**
 * Thrown when a requested entity instance is not found (Instance level)
 */
export class EntityNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityNotFoundError';
  }
}

/**
 * Thrown when a specific entity snapshot is not found (Version level)
 */
export class SnapshotNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotNotFoundError';
  }
}

/**
 * Thrown when trying to access a deleted entity
 */
export class EntityDeletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityDeletedError';
  }
}

/**
 * Thrown when URI format is invalid
 */
export class InvalidUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUriError';
  }
}
