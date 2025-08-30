# Consolidate URI Definition, Parsing, and Construction

## Context

Currently, URI handling for entities is scattered across multiple files in the codebase:

1. **`src/entity-uri-router.ts`** - Contains URI parsing logic and template definitions in comments
2. **`src/entities.ts`** - Contains resource template generation with hardcoded URI template strings
3. **`src/notification-service.ts`** - Contains URI construction for notifications
4. **Test files** - Contain hardcoded URI strings for testing

This creates several problems:
- **Duplication**: URI templates are defined in multiple places with slight variations
- **Inconsistency**: URI construction logic is scattered and could diverge
- **Maintenance burden**: Changes to URI format require updates in multiple files
- **Error prone**: Easy to miss updating one location when URI format changes
- **No single source of truth**: No centralized place to understand all URI patterns

The `entity-uri-router.ts` file is the natural place to consolidate all URI-related functionality since it already handles parsing and contains the core URI pattern regex.

## Objective

Consolidate all URI definition, parsing, and construction logic into `src/entity-uri-router.ts` to create a single source of truth for URI handling. This will eliminate duplication, ensure consistency, and make future URI changes easier to implement and maintain.

## Required Changes

### 1. Enhance `EntityUriRouter` Class

**Add URI Construction Methods**:
```typescript
/**
 * Construct entity URI from parameters
 * @param type - URI template type
 * @param params - URI parameters
 * @returns Constructed URI string
 */
buildEntityUri(type: UriTemplateType, params: EntityUriParams | PatchUriParams | HistoricalUriParams): string

/**
 * Get URI template string for a specific type
 * @param type - URI template type
 * @returns URI template with placeholder variables
 */
getUriTemplate(type: UriTemplateType): string

/**
 * Get all URI templates as resource templates for MCP protocol
 * @param entityTypeId - Optional entity type filter (e.g., "user@v1")
 * @returns Array of resource templates
 */
getResourceTemplates(entityTypeId?: string): ResourceTemplate[]
```

**Add URI Template Constants**:
- Move the hardcoded URI template strings from `entities.ts` into constants
- Use these constants for both parsing regex generation and construction
- Ensure templates are defined once and reused everywhere

### 2. Update `entities.ts`

**Remove URI Template Generation**:
- Remove the `getResourceTemplates()` method that currently generates URI templates
- Replace with calls to `EntityUriRouter.getResourceTemplates()`
- Update the method to delegate to the URI router instead of duplicating logic

**Example Change**:
```typescript
// Before:
getResourceTemplates(cursor?: string): ListResourceTemplatesResult {
  const resourceTemplates: ResourceTemplate[] = [];
  for (const entityType of this.#entityTypes.listEntityTypeDefinitions()) {
    const entityTypeId = `${entityType.name}@${entityType.version}`;
    resourceTemplates.push({
      name: `${entityTypeId} (Current)`,
      uriTemplate: `https://{domain}/{universe}/{galaxy}/{star}/entity/${entityTypeId}/{id}`,
      description: `Current entity of type ${entityTypeId}...`
    });
    // ... more hardcoded templates
  }
  return { resourceTemplates };
}

// After:
getResourceTemplates(cursor?: string): ListResourceTemplatesResult {
  const allTemplates: ResourceTemplate[] = [];
  
  // Get all entity types and generate templates for each
  for (const entityType of this.#entityTypes.listEntityTypeDefinitions()) {
    const entityTypeId = `${entityType.name}@${entityType.version}`;
    const templatesForType = this.#uriRouter.getResourceTemplates(entityTypeId);
    allTemplates.push(...templatesForType);
  }
  
  return { resourceTemplates: allTemplates };
}
```

### 3. Update `notification-service.ts`

**Remove URI Construction**:
- Remove hardcoded URI construction in `sendEntityUpdateNotification()`
- Replace with calls to `EntityUriRouter.buildEntityUri()`

**Example Change**:
```typescript
// Before:
const notification = {
  jsonrpc: "2.0",
  method: "notifications/resources/updated",
  params: {
    uri: `https://lumenize/universe/default/galaxy/default/star/default/entity/${entityTypeName}@${entityTypeVersion}/${entityId}`,
    title: `Entity ${entityTypeName}@${entityTypeVersion}: ${entityId}`,
    data: entityData
  }
};

// After:
const uri = this.#uriRouter.buildEntityUri(UriTemplateType.CURRENT_ENTITY, {
  domain: 'lumenize',
  universe: 'default',
  galaxy: 'default', 
  star: 'default',
  entityType: `${entityTypeName}@${entityTypeVersion}`,
  id: entityId
});

const notification = {
  jsonrpc: "2.0",
  method: "notifications/resources/updated",
  params: {
    uri,
    title: `Entity ${entityTypeName}@${entityTypeVersion}: ${entityId}`,
    data: entityData
  }
};
```

### 4. Update Constructor Dependencies

**Add URI Router to Notification Service**:
- Update `NotificationService` implementations to accept an `EntityUriRouter` instance
- Pass the URI router from `Entities` constructor to notification service
- This ensures consistent URI construction across all components

### 5. Update All Tests

**Replace Hardcoded URIs**:
- Update all test files to use `EntityUriRouter.buildEntityUri()` instead of hardcoded strings
- This ensures tests stay in sync with URI format changes
- Makes tests more readable by showing the intent (entity type, operation type) rather than raw strings

**Example Change**:
```typescript
// Before:
const uri = 'https://lumenize/universe/default/galaxy/default/star/default/entity/comprehensive-test-entity@v1/test-123';

// After:
const uri = uriRouter.buildEntityUri(UriTemplateType.CURRENT_ENTITY, {
  domain: 'lumenize',
  universe: 'default',
  galaxy: 'default',
  star: 'default', 
  entityType: 'comprehensive-test-entity@v1',
  id: 'test-123'
});
```

### 6. Add URI Template Validation

**Template Consistency Validation**:
- Add internal validation to ensure URI templates and parsing regex stay in sync
- Add unit tests that verify round-trip consistency (build -> parse -> build)
- This prevents regression when URI formats are modified

## Implementation Strategy

1. [x] **Start with URI router enhancement** - Add construction methods and template constants
2. [x] **Update notification service** - Replace hardcoded URI construction
3. [x] **Update entities.ts** - Replace template generation with delegation to URI router
4. [x] **Update constructor dependencies** - Pass URI router to notification service
5. [x] **Update all tests** - Replace hardcoded URIs with construction method calls
6. [x] **Add validation tests** - Ensure consistency between templates and parsing

## Benefits After Implementation

1. **Single source of truth** - All URI logic centralized in one file
2. **Consistency guaranteed** - Same logic used for parsing, construction, and templates
3. **Easier maintenance** - URI format changes only require updates in one place
4. **Better testing** - Tests use same construction logic as production code
5. **Reduced duplication** - No more copy-paste URI template strings
6. **Type safety** - URI construction is type-checked and validated
7. **Future flexibility** - Easy to add new URI types or modify existing ones

## Files to Modify

- `src/entity-uri-router.ts` - Add construction methods and template constants
- `src/entities.ts` - Replace template generation with delegation
- `src/notification-service.ts` - Replace hardcoded URI construction
- `test/unit-entity-uri-router.test.ts` - Add construction and validation tests
- `test/integration-entity-lifecycle.test.ts` - Replace hardcoded URIs
- Any other test files with hardcoded entity URIs

## Validation

After implementation, verify:
1. All URI construction goes through `EntityUriRouter`
2. URI templates are defined once and reused everywhere
3. Tests use construction methods instead of hardcoded strings
4. Round-trip consistency (build -> parse -> build) works correctly
5. No URI format duplication remains in the codebase
6. Resource template generation works correctly via delegation

## Notes

- This change maintains backward compatibility - no URI formats change
- This is purely a refactoring to consolidate scattered logic
- The consolidation will make the subsequent "remove entity type from URIs" change much easier
- Consider adding TypeScript strict mode to catch any missed URI construction calls
- The URI router could potentially be extracted into a separate module for reuse
