# Remove EntityType from URIs

## Context

The current URI structure includes `entityType` (which is `entityTypeName@entityTypeVersion`) in the path:
```
https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{entityType}/{id}
```

This was originally included to support migrations and versioning, but analysis shows:
1. Current operations ignore the version specified in the URI and always use the latest version
2. Migrations will always be to the latest version, making it unecessary to specify what version to migrate to in the uri
3. The entityType in the URI adds complexity without providing value
4. Entity type information is already stored in the database and can be retrieved from there

## Objective

Simplify the URI structure by removing the `entityType` parameter, resulting in:
```
https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}
```

**Note**: This implementation is significantly simplified due to recent URI consolidation work that created a single source of truth for all URI operations in `EntityUriRouter`. Most changes are now centralized in one file.

## Required Changes

### 1. URI Router Updates (`src/entity-uri-router.ts`)

**This is now the single source of truth for all URI handling after recent consolidation work.**

- **Update `ENTITY_URI_PATTERN` regex**: Change from 7 capture groups to 6 by removing the entityType group:
  ```typescript
  // From: /^https:\/\/([^\/]+)\/universe\/([^\/]+)\/galaxy\/([^\/]+)\/star\/([^\/]+)\/entity\/([^\/]+)\/([^\/]+)(?:\/(.+))?$/
  // To:   /^https:\/\/([^\/]+)\/universe\/([^\/]+)\/galaxy\/([^\/]+)\/star\/([^\/]+)\/entity\/([^\/]+)(?:\/(.+))?$/
  ```

- **Update `URI_TEMPLATES` constants**: Remove `{entityType}` from all four template strings:
  ```typescript
  // From: 'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{entityType}/{id}'
  // To:   'https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity/{id}'
  ```

- **Update interfaces**: Remove `entityType` from:
  - `EntityUriParams`
  - `PatchUriParams` 
  - `HistoricalUriParams`

- **Update `parseEntityUri()` method**: 
  - Change destructuring from `[, domain, universe, galaxy, star, entityType, id, suffix]` to `[, domain, universe, galaxy, star, id, suffix]`
  - Remove entityType from returned `EntityUriInfo` object
  - Update validation to not require entityType

- **Update `buildEntityUri()` method**: 
  - Remove entityType parameter handling
  - Update template replacement logic

- **Update `getResourceTemplates()` method**: 
  - Simplify to return only 4 generic templates (not per entity type)
  - Remove entityTypeId parameter since URIs no longer include entity type
  - Update template descriptions to be generic
  - **Add fifth template for entity registry**: `https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity-types`

- **Update validation patterns**: Remove entityType validation since it's no longer in URIs

- **Add entity registry template and handling**:
  - Add fifth URI template: `https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity-types`
  - Add parsing logic to detect entity registry URIs
  - Add method to handle entity registry resource reads (return JSON of all entity type definitions)
  - Add HTTP GET handling for entity registry URIs (same as MCP `resources/read`)

### 2. Notification Service Updates (`src/notification-service.ts`)

**Already updated to use EntityUriRouter during consolidation, but needs parameter simplification.**

- **Update `sendEntityUpdateNotification()` method**: 
  - Remove `entityTypeName` and `entityTypeVersion` from URI construction parameters
  - Simplify `buildEntityUri()` call to only pass domain, universe, galaxy, star, and entityId

### 3. Entities Class Updates (`src/entities.ts`)

**Already updated to delegate to EntityUriRouter during consolidation, but needs simplification.**

- **Update `getResourceTemplates()` method**: 
  - Remove the loop over entity types since URIs no longer include entity type
  - Call `uriRouter.getResourceTemplates()` without entityTypeId parameter
  - Return the generic 4 templates plus entity registry template

### 4. Entity Operations Updates

**Entity operations already use EntityUriRouter after consolidation, so changes should be minimal.**

- **Verify all entity operations** (UpsertEntity, DeleteEntity, UndeleteEntity, ReadEntity) work with simplified URIs from EntityUriRouter
- **Confirm entity type information** is properly retrieved from database rather than URI in all operations
- **Test that URI parsing and construction** continues to work through EntityUriRouter

### 5. Test Updates

**Tests already use EntityUriRouter.buildEntityUri() after consolidation, so updates are straightforward.**

- **Update test expectations** to remove entityType from buildEntityUri() calls:
  ```typescript
  // From: uriRouter.buildEntityUri(UriTemplateType.CURRENT_ENTITY, {
  //   domain: 'lumenize', universe: 'default', galaxy: 'default', star: 'default',
  //   entityType: 'comprehensive-test-entity@v1', id: entityId
  // })
  // To: uriRouter.buildEntityUri(UriTemplateType.CURRENT_ENTITY, {
  //   domain: 'lumenize', universe: 'default', galaxy: 'default', star: 'default',
  //   id: entityId
  // })
  ```

- **Update unit tests** in `test/unit-entity-uri-router.test.ts`:
  - Update test URI constants to remove entityType
  - Update test parameter objects
  - Update expectation strings

- **Update integration tests** in `test/integration-entity-lifecycle.test.ts`:
  - Remove entityType from all buildEntityUri() calls
  - Update any hardcoded URI expectations

- **Update resource template tests** in `test/integration-resources-entity-types.test.ts`:
  - Expect only 4 generic templates + entity registry (not per entity type)
  - Update URI template expectations
  - Test that entity registry template returns proper resource via `resources/read`
  - Test that entity registry URI works via HTTP GET

### 6. HTTP Request Handling

**HTTP handling already goes through EntityUriRouter after consolidation.**

- **Verify HTTP request parsing** works with simplified URI structure through EntityUriRouter
- **Confirm entity type lookup** happens via database queries in entity operations
- **Test URI pattern matching** continues to work in request routing
- **Add HTTP GET support for entity registry**: Add parsing and handling for `https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity-types` requests

## Implementation Strategy

**Incremental approach with isolated, testable steps.**

### Phase 1: Add Entity Registry Template (Isolated)
- [x] **Step 1: Add Fifth Resource Template for Entity Registry**
  - Add `entity-types` URI template to `EntityUriRouter.getResourceTemplates()`
  - Add parsing logic for entity registry URIs in `parseEntityUri()`
  - Add method to handle entity registry resource reads (return JSON of all entity type definitions)
  - Add HTTP GET handling for entity registry URIs
  - Update `src/entities.ts` to include the fifth template
  - Test entity registry functionality via both MCP `resources/read` and HTTP GET
  - **Validation**: Verify fifth template works without affecting existing functionality

### Phase 2: Core URI Structure Changes (Major Change)
- [x] **Step 2: Update EntityUriRouter Core Logic**
  - Update `ENTITY_URI_PATTERN` regex (7 to 6 capture groups)
  - Update `URI_TEMPLATES` constants (remove `{entityType}` from all four templates)
  - Update interfaces (`EntityUriParams`, `PatchUriParams`, `HistoricalUriParams`)
  - Update `parseEntityUri()` method (change destructuring and remove entityType validation)
  - Update `buildEntityUri()` method (remove entityType parameter handling)
  - **Validation**: Run unit tests for EntityUriRouter to ensure parsing/building works

### Phase 3: Update Dependent Services (Safe Updates)
- [x] **Step 3: Update Notification Service**
  - Remove `entityTypeName` and `entityTypeVersion` from `sendEntityUpdateNotification()`
  - Simplify `buildEntityUri()` calls to exclude entity type parameters
  - **Validation**: Test notification sending with new URI format

- [x] **Step 4: Update Resource Template Generation**
  - Update `src/entities.ts` `getResourceTemplates()` to return generic templates
  - Remove loop over entity types since URIs no longer include entity type
  - **Validation**: Verify `resources/templates/list` returns 5 generic templates

### Phase 4: Test Updates (Safe Updates)
- [x] **Step 5: Update Unit Tests**
  - Update `test/unit-entity-uri-router.test.ts` test data and expectations
  - Remove entityType from test URI constants and parameter objects
  - **Validation**: All EntityUriRouter unit tests pass

- [x] **Step 6: Update Integration Tests**
  - Update `test/integration-entity-lifecycle.test.ts` buildEntityUri() calls
  - Update `test/integration-resources-entity-types.test.ts` template expectations
  - Remove entityType parameters from all test buildEntityUri() calls
  - **Validation**: All integration tests pass with new URI structure

### Phase 5: Final Validation (End-to-End)
- [x] **Step 7: Comprehensive Testing**
  - Run complete test suite to verify all functionality
  - Test entity operations (UpsertEntity, DeleteEntity, etc.) work with simplified URIs
  - Verify HTTP request handling works through EntityUriRouter
  - Confirm entity type lookup happens via database queries
  - Test notification system end-to-end
  - **Validation**: All tests pass, no performance degradation

**Benefits of this approach:**
- Step 1 can be implemented and tested in complete isolation
- Steps 2-4 form the core change but are grouped by concern
- Steps 5-6 are safe test updates that validate the changes
- Each step has clear validation criteria before proceeding
- Rollback is easier if issues are discovered at any step

## Migration Considerations

- **This is a breaking change** for any clients using the current URI format
- **Existing subscriptions** with old URI format will need to be updated
- **Consider implementing a grace period** where both old and new URI formats are supported temporarily
- **Update any documentation** or API references that mention the old URI format

## Benefits After Implementation

1. **Simplified URI structure** - Easier to understand and construct
2. **Reduced complexity** - No need to parse/validate entity type from URI
3. **Better separation of concerns** - Entity type is a data concern, not a URI concern
4. **Future flexibility** - URI structure won't need to change for entity migrations
5. **Consistent behavior** - URI format matches actual system behavior (always use latest version)
6. **Leverages consolidation** - Implementation is much simpler due to single source of truth in EntityUriRouter
7. **Entity registry discoverability** - Fifth template provides access to complete entity type registry
8. **Fewer resource templates** - Generic templates instead of per-entity-type duplication
9. **Cleaner MCP protocol** - Simpler resource template list for clients

## Files to Modify

**Significantly reduced due to URI consolidation:**

- `src/entity-uri-router.ts` - **Primary change**: Update all URI patterns, parsing, construction, and template generation
- `src/notification-service.ts` - **Minor change**: Remove entityType parameter from URI construction calls  
- `src/entities.ts` - **Minor change**: Update to return generic templates instead of per-entity-type
- `test/unit-entity-uri-router.test.ts` - Update test data and expectations
- `test/integration-entity-lifecycle.test.ts` - Remove entityType from buildEntityUri() calls
- `test/integration-resources-entity-types.test.ts` - Update template expectations

**Files that should NOT need changes** (thanks to consolidation):
- Entity operation files (UpsertEntity, DeleteEntity, etc.) - they use EntityUriRouter
- HTTP request handling - goes through EntityUriRouter
- Other test files - already use EntityUriRouter.buildEntityUri()

## Validation

After implementation, verify:
1. All four URI templates work correctly (current, patch subscribe, patch read, historical)
2. Entity registry template works correctly and returns complete type registry
3. Entity registry URI works via both MCP `resources/read` and HTTP GET
4. Notifications use the correct simplified URI format
5. All tests pass with new URI structure
6. Entity operations continue to work correctly
7. Resource templates reflect the new URI format (5 templates total)
8. No performance degradation from additional database lookups for entity type


## Additional Notes

- Only accept the latest version of the entity type for upserts. Continue to require the entityTypeName and entityTypeVersion in the upsert request body and throw/return an error if the version is not the latest.
- The call to resources/templates/list should return only our five specified generic URI templates, not those four per entity type as they do now.
- The fifth template (`https://{domain}/universe/{universe}/galaxy/{galaxy}/star/{star}/entity-types`) provides access to the complete entity type registry as a resource via both `resources/read` and HTTP GET.
