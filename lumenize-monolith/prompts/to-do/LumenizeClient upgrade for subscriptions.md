# TODO FOR THIS DOC

- [ ] Make the signature of the subscription look like the Juris subscription signature: `subscribe(entityURIPathname, (value) => { ... })`. EntityURIPathname might look like `{universeId}.{galaxyId}.{starId}.{entityId}` to match the JurisJS pattern. However, right now, I think it should be `universe/{universeId}/galaxy/{galaxyId}/star/{starId}/entity/{entityId}` to match our current URI scheme

# LumenizeClient for subscriptions

The next goal is to upgrade LumenizeClient (in lumenize-client.ts) to handle entity (resources) subscription updates in both directions and which will work with the Lumenize (server) in lumenize-server.ts model context protocol (MCP) subscription functionality we recently implemented.

## Requirements

- Provide entityUpsert, entityDelete, and entityUndelete public methods. Instead of two-way binding, we'll use unidirectional flow where changes flowing upstream are via these explicit method and changes flowing downstream are via Observable subscriptions.

- Implement the Observable API (essentially an extension of EventTarget). See: https://github.com/WICG/observable. We'll use the npm package, "observable-polyfill" which is already installed to allow browser-based UI to subscribe to particular entityId's. LumenizeClient will keep track of these subscriptions and emit events (or the equivalent in Observable()) for any changes.

- There will be one LumenizeClient per browser context (so make it a singleton) which will keep track of all subscriptions for that context. **Each browser tab maintains its own WebSocket connection for simplified architecture - cross-tab synchronization happens through server-driven updates rather than complex client-side coordination.** The LumenizeClient will send subscription requests to the server for each entityId that is subscribed to. The server will then send updates to the client when those entities change.

- However, it will be possible for two different UI elements to subscribe to the same entityId. In that case, the LumenizeClient will only send one subscription request to the server for that entityId, but will emit events to all subscribers when that entity changes. Only when the UI element subscriptions are all removed will the LumenizeClient send an unsubscribe request to the server.

- Keep the current value and metadata for each subscribed entityId in IndexedDB with the key `lumenize:entity:<entityId>`. **IndexedDB chosen over LocalStorage to eliminate race conditions through atomic transactions.** When a new UI subscription is made, immediately emit the current value to the subscriber (optimistic caching for instant UX). If the entity is not in IndexedDB, the 'resources/subscribe' call will return the latest value. Store that in IndexedDB before emitting it to the UI subscriber. Use the `baseline` parameter when making the subscription if there is a prior version in IndexedDB but no active UI subscriptions.

- By default, for existing subscriptions the server-side will only transmit the json merge patch (RFC 7396) for changes to the entity. However, I believe that notification also indicates the base for the patch (maybe with a validFrom timestamp, or possible a `baseline`). However, it may be possible for the client to have missed some updates. So, if it doesn't match the latest local version, then ignore the patch and submit a 'resources/read' call with the `baseline` parameter to get the appropriate value to catch up.

- For new subscriptions from this client, there is an option to pass in the `baseline` date on the creation of the subscription between LumenizeClient and the server. Use this for cases where the entityId is in IndexedDB but there were no active UI subscriptions. This will allow the client to catch up with the latest value during the subscribe process. **Server upgrade needed: Currently server accepts but doesn't use the `baseline` parameter - needs to be enhanced to use `baseline` and make it's immediate `notifications/resources/update` notification be from this initial baseline.**

- I believe Lumenize (server) in lumenize-server.ts already has the necessary functionality to handle subscriptions, but we may need to make some adjustments to ensure it works correctly with the new client-side subscription model.

- Validate the output of tool calls on the client side using "@cfworker/json-schema" using the JSON Schema that comes down from calling 'tools/list'. Similarly, use the schema from 'resources/list' to validate updates from the server. We should already validate them on the server-side using the inputSchema but please confirm that. Favor JSON Schema validation + tests over Typescript types. 

## Guidance

- Use TypeScript and follow the existing coding style in lumenize-client.ts and lumenize-server.ts.
- When there is an accompianying JSON Schema, use the minimally specificTypescript types necessary to get the Typescript compiler to stop complaining.


## Planning

Based on my analysis of the current codebase, here's a comprehensive multi-step implementation strategy:

### Architecture Overview

The LumenizeClient will be enhanced with:
1. **Singleton pattern** - One client instance per browser context
2. **Observable API** - Using the existing `observable-polyfill` package
3. **Subscription management** - Track UI subscriptions vs server subscriptions
4. **LocalStorage persistence** - Cache entity values with automatic patch handling
5. **JSON Schema validation** - Client-side validation of server responses

### Phase 1: Core Infrastructure Setup (Test independently)

**Step 1.1: Singleton Pattern Implementation**
- Convert LumenizeClient to singleton with static `getInstance()` method (per-window scope)
- Each browser tab/window has its own LumenizeClient instance with independent WebSocket connection
- LocalStorage naturally shared between tabs, but each tab manages its own subscriptions independently
- Add proper cleanup on singleton destruction
- Test: Verify only one instance exists across multiple component instantiations

**Step 1.2: Observable Integration**  
- Import and configure `observable-polyfill`
- Create `EntityObservable` class extending Observable for type safety
- Add basic subscription/unsubscription methods for UI components
- Test: Basic Observable subscription/emission without server communication

**Step 1.3: Entity Cache Manager**
- Create `EntityCacheManager` class to handle IndexedDB operations (replaces LocalStorage)
- Implement get/set/remove for `lumenize:entity:<entityId>` keys with atomic transactions
- Include metadata storage (timestamps, versions, etc.)
- **Optimistic Caching Strategy:**
  - Keep cached entities indefinitely (no deletion when subscriber count reaches zero)
  - Immediate emission of cached values for instant UX
  - Background refresh using `baseline` parameter to get patches from cached version
  - Shared IndexedDB across all browser tabs while each tab manages its own subscriptions
- Test: Cache operations work correctly with proper serialization and atomic transactions

### Phase 2: Subscription Management (Test with mock data)

**Step 2.1: UI Subscription Tracking**
- Add internal Map to track UI subscriptions per entityId
- Implement reference counting for multiple UI subscriptions to same entity
- Add methods: `subscribeToEntity()`, `unsubscribeFromEntity()`
- Test: Reference counting works correctly with multiple UI subscribers

**Step 2.2: Server Subscription Coordination**
- Create logic to determine when to send server subscribe/unsubscribe requests
- Server subscription only created on first UI subscription
- Server unsubscription only sent when last UI subscription is removed
- Test: Mock server calls to verify correct subscribe/unsubscribe timing

**Step 2.3: Immediate Value Emission**
- When UI subscribes, immediately emit cached value if available
- If no cached value, trigger server subscription and cache result before emission
- Test: UI receives immediate values from cache or fresh server data

### Phase 3: Server Communication Enhancement (Test with live server)

**Step 3.1: WebSocket Message Handling Enhancement**
- Extend existing WebSocket message handler to process notifications
- Handle both full entity updates and JSON merge patches
- Add patch validation and baseline checking
- Test: Receive and process various notification types from server

**Step 3.2: Patch Management**
- Implement RFC 7396 JSON merge patch application
- Add baseline validation for patch consistency
- Implement fallback to `resources/read` when patches are out of sync
- Test: Patch application and recovery scenarios

**Step 3.3: Entity CRUD Methods**
- Add `entityUpsert(entityId, data)` method using existing `callTool("upsert_entity")`
- Add `entityDelete(entityId)` method using existing `callTool("delete_entity")`  
- Add `entityUndelete(entityId)` method using existing `callTool("undelete_entity")`
- **Optimistic Updates & Conflict Resolution**: 
  - Apply changes locally and emit immediately for instant UX
  - Always send `baseline` parameter with updates to detect staleness
  - Server's single-threaded Durable Object ensures first update wins
  - On baseline mismatch, fetch fresh state and emit `entity-conflict` event for UI handling
  - **Server optimization needed**: Skip notifying originating client since it already has the data
- Ensure these methods trigger local cache updates
- Test: CRUD operations work and trigger proper notifications, including conflict scenarios

### Phase 4: Advanced Features (Test edge cases)

**Step 4.1: Schema Validation**
- Use existing `#availableTools` Map to get entity schemas from `tools/list`
- Implement client-side validation of server notifications using `@cfworker/json-schema`
- Add validation for both tool call results and subscription updates
- **Schema Version Handling**: Only real scenario is client behind server (cached schemas are stale after server update). On validation failure for server notifications, refresh `tools/list` to get current schemas and retry validation once. If validation still fails after refresh, it's a real data error.
- Test: Schema validation catches malformed data and handles schema version updates

**Step 4.2: Error Handling & Recovery**
- Handle entity deletion notifications (emit deletion event, clean up cache)
- Implement reconnection logic for WebSocket disconnections
- Add retry mechanisms for failed patch applications
- Handle cases where entity doesn't exist during subscription
- Test: Various failure scenarios and recovery mechanisms

**Step 4.3: Performance Optimizations**
- Implement debouncing for rapid patch updates
- Add memory limits for LocalStorage cache
- Optimize subscription cleanup on page unload
- Test: Performance under high-frequency updates

### Phase 5: Integration & Testing (End-to-end testing)

**Step 5.1: Server Compatibility Verification**
- Verify server-side subscription implementation works with new client
- Test patch generation and baseline handling
- Ensure proper cleanup when connections close
- Test: Full client-server subscription lifecycle

**Step 5.2: Multi-tab/Window Scenarios**
- Test singleton behavior across browser tabs (each tab has its own LumenizeClient instance)
- Verify IndexedDB sharing between tabs while maintaining independent subscriptions
- Handle server-driven cross-tab updates through WebSocket notifications
- Test: Multiple browser contexts work correctly with server-coordinated updates

**Step 5.3: Edge Case Testing**
- Entity deletion while subscribed
- Network disconnection during active subscriptions
- Cache corruption scenarios
- Memory pressure and cleanup
- Test: System remains stable under edge conditions

### Implementation Notes

**Subscription State Management:**
```typescript
interface EntitySubscription {
  entityId: string;
  uiSubscriptionCount: number;
  hasServerSubscription: boolean;
  observable: EntityObservable;
  lastKnownValue?: any;
  lastKnownTimestamp?: string;
}
```

**LocalStorage Schema:**
```typescript
interface CachedEntity {
  entityId: string;
  value: any;
  timestamp: string;
  lastAccessed: string;  // Track for LRU cleanup
  entityTypeName: string;
  entityTypeVersion: number;
  validFrom: string;
  isCurrentlySubscribed: boolean; // Protect from eviction
}
```

**IndexedDB Schema (Updated):**
```typescript
interface CachedEntity {
  entityId: string;        // Primary key
  value: any;              // Full entity data
  validFrom: string;       // Used as baseline for patches
  entityTypeName: string;
  entityTypeVersion: number;
  lastAccessed: string;    // For future cleanup if needed
  cachedAt: string;        // When entity was cached
}
```

**Observable Event Types:**
- `entity-updated`: Full entity update
- `entity-patched`: Incremental patch update  
- `entity-deleted`: Entity deletion
- `entity-conflict`: Baseline mismatch requiring UI intervention
- `entity-error`: Subscription or validation errors


## Learning

While working, recognize what information would help you do the task better and faster next time. For example where is what in the project and save them to lumenize/prompts/ai-learnings.md file in the project. Use that file to do things better and faster.


## Later

1. **Reconnection Strategy**: We'll need to monitor the WebSocket close event and figure out a strategy for reconnecting with exponential backoff.

This phased approach allows for testing and validation at each step, with clear decision points where we can adjust the approach based on findings.
