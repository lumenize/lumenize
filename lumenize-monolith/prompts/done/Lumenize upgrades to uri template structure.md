# Lumenize (server) URI Template behavior improvements

## URI Template Design for Entity Resource Management

This document outlines the requirements for upgrading Lumenize with four distinct URI templates for handling entity operations. This work is in preparation for enhancing the LumenizeClient to support subscriptions with patch-based updates.

### Four URI Templates

#### 1. Current Entity Resource
**URI Pattern:** `/entity/{entityType}@{entityTypeVersion}/{entityId}`

**Usage:**
- `resources/read` operations
- `resources/subscribe` operations  
- HTTP GET requests
- `tools/call` for upsert, delete, and undelete operations

**Capabilities:**
- Full-value read access
- Entity upsert, delete, and undelete operations
- Real-time subscriptions

**Subscription Behavior:**
1. Initial `resources/subscribe` response: Empty JSON-RPC response (per spec)
2. Immediately after: Send `notifications/resources/updated` with current full entity value
3. Subsequent updates: Send `notifications/resources/updated` with full entity values on each change

**Example Flow:**
```
Client → resources/subscribe to /entity/User@1.0/user123
Server → {"jsonrpc": "2.0", "id": 1, "result": {}}
Server → notifications/resources/updated with full current entity
[Later] Server → notifications/resources/updated with full entity on each change
```

#### 2. Patch Update/Subscribe Resource
**URI Pattern:** `/entity/{entityType}@{entityTypeVersion}/{entityId}/patch`

**Usage:**
- `tools/call` method: `upsert-entity` for patch-based updates
- `resources/subscribe` for patch-based subscriptions

**Capabilities:**
- Patch-based entity updates
- Patch-based subscription streams
- Throws, Logs, and returns an error if the provided baseline does not match any validFrom for the entity

**Update Behavior:**
- Requires `baseline` parameter in request body for `tools/call` operations
- Applies RFC 7396 JSON merge patch to entity from provided baseline using json-merge-patch library

**Subscription Behavior:**
1. Requires (non-MCP-standard) `baseline` parameter in `resources/subscribe` request
2. Initial response: Empty JSON-RPC response (per spec)
3. Immediately after: Send `notifications/resources/updated` with patch from provided baseline to current state
4. Subsequent updates: Send `notifications/resources/updated` with patches between the new snapshot and the one immediately prior. This update includes the baseline (in the validFrom field) timestamp for the patch on the client. If the client has missed updates and its baseline doesn't match what the server sent, it must ignore the patch value and initiate another round-trip using 'resources/read' with uri type 3 (`.../patch/{baselineTimestamp}`) to get the latest entity state/snapshot.

**Example Flows:**

**Flow 2a - Patch Update:**
```
Client → tools/call upsert-entity to /entity/User@1.0/user123/patch
         with baseline: "2024-01-01T10:00:00Z" and patch: {"name": "Updated Name"}
Server → {"jsonrpc": "2.0", "id": 1, "result": {"success": true, "newValidFrom": "2024-01-01T10:05:00Z"}}
```

**Flow 2b - Patch Subscription:**
```
Client → resources/subscribe to /entity/User@1.0/user123/patch 
         with baseline parameter: "2024-01-01T10:00:00Z"
Server → {"jsonrpc": "2.0", "id": 1, "result": {}}
Server → notifications/resources/updated with patch from baseline to current
[Later] Server → notifications/resources/updated with patch between consecutive versions
```

#### 3. Patch Read Resource
**URI Pattern:** `/entity/{entityType}@{entityTypeVersion}/{entityId}/patch/{baselineTimestamp}`

Note, this is currently implemented except on uri template #1 with the baselineTimestamp in the url search params as "patchFrom". Keep the code from that work and wire it up to this uri. Also, remove the "patchFrom" search param from uri template #1.

**Usage:**
- `resources/read` operations only
- HTTP GET requests only

**Capabilities:**
- Throws an error if the baselineTimestamp does not match any snapshot validFrom timestamp for the entity
- Returns RFC 7396 JSON merge patch from specified baseline timestamp to current state

**Restrictions:**
- No subscription capability
- No write operations

**Example Flow:**
```
Client → resources/read /entity/User@1.0/user123/patch/2024-01-01T10:00:00Z
Server → RFC 7396 JSON merge patch representing changes from baseline to current
```

#### 4. Historical Point-in-Time Resource
**URI Pattern:** `/entity/{entityType}@{entityTypeVersion}/{entityId}/at/{timestamp}`

Note, this is currently implemented except on uri template #1 with the timestamp in the url search params as "at". Keep the code from that work and wire it up to this uri. Also, remove the "at" search param from uri template #1.

**Usage:**
- `resources/read` operations only
- HTTP GET requests only

**Capabilities:**
- Historical value retrieval at specified timestamp
- Read-only access to past entity states

**Restrictions:**
- No subscription capability
- No write operations

**Example Flow:**
```
Client → resources/read /entity/User@1.0/user123/at/2024-01-01T10:00:00Z
Server → Full entity state as it existed at the specified timestamp
```


### Key Implementation Requirements

#### Leave well enough alone
- Unless necessary to achieve the new functionality, avoid changing existing behavior
- Play particular attention to not change the if statement blocks that start with this comment `// Every snapshot must have a unique and monotonically increasing validFrom timestamp`. For some reason, every time the LLM works on that code, it changes the logic in a way that breaks desired functionality.
- When in doubt, ask for clarification before making changes

#### JSON-RPC and MCP Compliance
- All `resources/subscribe` calls return the expected empty JSON-RPC responses first
- After that, notifications from server for subscriptions established with `resources/subscribe` are sent separately using `notifications/resources/updated` per the MCP spec
- Follow JSON-RPC 2.0 specification for all responses

#### JSON schema validation
- Generate partial JSON-Schema for incoming json merge patch validation from configured full entity JSON-Schema. Note, JSON merge patch uses `null` to indicate property deletion, so the generated schema must allow `null` for all properties. However, there should be no properties in the provided patch that are not in the original schema.
- Favor json schema validation and testing over precise Typescript types. For variables that are going to get JSON Schema validation anyway, use the most generic Typescript type to keep tsc from complaining, e.g. `Record<string, any>`, rather than a precise type that will be validated by JSON Schema anyway.
- Use existing schemas where possible, only create new ones if absolutely needed. Be sure to check in lumenize/src/schemas/draft before creating new schemas.
- Do not validate outgoing values against schema. That's the responsiblity of the client.

#### Use already install libraries
- "json-merge-patch". Use for applying and generating RFC 7396 JSON merge patches
- "uri-template-router". Use for all URI template parsing needs
- "@cfworker/json-schema". Use for all JSON schema validation needs.

#### Error Handling
- Follow established error handling practices with clear error message
- Use the established JavaScript object error logging format
- Implement proper HTTP status codes and JSON-RPC error responses


# Response from LLM

The core URI template infrastructure is complete. The remaining items from your original requirements are:

1. Subscription Notifications: Implement notifications/resources/updated with patches between consecutive versions
2. JSON Schema Validation: Generate partial JSON-Schema for incoming JSON merge patch validation
3. Comprehensive Testing: Add thorough test coverage for all template types