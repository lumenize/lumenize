# Multi-Phase Implementation: MCP WebSocket SEP Reference Implementation

This prompt outlines the multi-phase implementation of reference libraries for the MCP WebSocket transport SEP.

## Phase 1: Fork and Create MCPReconnectingWSClient

### Objective
Create a standalone client library based on PartySocket that implements the MCP WebSocket SEP specification.

### Tasks
1. **Fork PartySocket Repository**
   - Create new repository: `mcp-reconnecting-ws-client`
   - Remove PartyKit-specific branding and dependencies
   - Update package.json with new name and description

2. **Rename Core Classes**
   - `PartySocket` → `MCPReconnectingWSClient`
   - Update all internal references and exports

3. **Implement SEP Session ID Handling**
   - Replace `_pk` parameter with `mcp_session_id`
   - Add cookie fallback support as specified in SEP
   - Maintain session ID persistence across reconnections

4. **Add MCP-Specific Features**
   - Built-in MCP initialization handshake
   - Tool discovery and caching
   - JSON-RPC request/response correlation
   - MCP-specific error handling

5. **Remove PartyKit Dependencies**
   - Extract generic WebSocket reconnection logic
   - Remove party/room concepts
   - Simplify to basic WebSocket URL connection

### Deliverables
- Standalone npm package: `@mcp/reconnecting-ws-client`
- TypeScript definitions
- Documentation and examples
- Unit tests

---

## Phase 2: Fork and Create MCPWebSocketServer

### Objective  
Create a Cloudflare Workers-compatible server library that implements the server side of the MCP WebSocket SEP.

### Tasks
1. **Fork PartyServer Repository**
   - Create new repository: `mcp-websocket-server`
   - Extract core WebSocket handling logic
   - Remove PartyKit-specific features (rooms, parties, etc.)

2. **Implement SEP Server Requirements**
   - Session ID extraction from URL params and cookies
   - Session state management and persistence
   - Connection rejection for missing session IDs
   - Reconnection handling with session correlation

3. **Add MCP Protocol Support**
   - JSON-RPC 2.0 message parsing and validation
   - MCP initialization handshake handling
   - Tool registration and discovery endpoints
   - Error response formatting per MCP spec

4. **Cloudflare Workers Integration**
   - Durable Objects integration for session persistence
   - WebSocket hibernation support
   - Environment variable configuration

5. **Session Management**
   - Session timeout policies
   - Cleanup of orphaned sessions
   - Concurrent connection handling (last connection wins)

### Deliverables
- Cloudflare Workers package: `@mcp/websocket-server`
- Durable Object session storage implementation
- Configuration utilities
- Integration examples

---

## Phase 3: Update LumenizeClient Implementation

### Objective
Migrate the existing LumenizeClient from PartySocket to the new MCPReconnectingWSClient.

### Tasks
1. **Replace PartySocket Dependency**
   - Update package.json to use `@mcp/reconnecting-ws-client`
   - Remove custom `subscriberId` generation
   - Update import statements

2. **Simplify Connection Logic**
   - Remove custom session ID handling (now built into client)
   - Leverage built-in MCP initialization
   - Use client's built-in tool discovery

3. **Update Configuration**
   - Change from PartyKit's party/room model to simple WebSocket URLs
   - Update `galaxy`/`star` concepts to direct URL construction
   - Maintain backwards compatibility where possible

4. **Enhance Reconnection Handling**
   - Leverage client's automatic reconnection
   - Update state management for session persistence
   - Improve error handling and recovery

### Code Changes Required
```typescript
// Before (PartySocket)
import { PartySocket } from "partysocket";
const subscriberId = crypto.randomUUID();
const socketOpts = { 
  prefix: 'universe', 
  party: galaxy ?? "milky-way", 
  room: star,
  query: { subscriberId }
};
this.#partySocket = new PartySocket(socketOpts);

// After (MCPReconnectingWSClient)
import { MCPReconnectingWSClient } from "@mcp/reconnecting-ws-client";
const wsUrl = `wss://universe.${galaxy ?? "milky-way"}.workers.dev/${star}`;
this.#mcpClient = new MCPReconnectingWSClient({
  url: wsUrl,
  mcpVersion: clientVersion,
  capabilities: opts.capabilities,
  clientInfo: opts.clientInfo,
  onEntityUpdate: opts.onEntityUpdate
});
```

### Deliverables
- Updated `lumenize-client.ts` using new library
- Backwards compatibility layer if needed
- Updated tests and documentation

---

## Phase 4: Update LumenizeServer Implementation

### Objective
Update the server-side Lumenize implementation to use the new MCPWebSocketServer library.

### Tasks
1. **Integrate MCPWebSocketServer**
   - Add dependency on `@mcp/websocket-server`
   - Replace custom WebSocket handling with library
   - Update Durable Object to use session management

2. **Implement SEP Server Behavior**
   - Session ID validation and extraction
   - Connection rejection for invalid sessions
   - Session state persistence in Durable Objects

3. **Update MCP Protocol Handling**
   - Use library's built-in JSON-RPC handling
   - Implement proper MCP initialization responses
   - Add tool registration and discovery

4. **Migration Strategy**
   - Maintain compatibility with existing clients during transition
   - Support both old and new session ID formats temporarily
   - Gradual rollout plan

### Code Changes Required
```typescript
// Before (custom WebSocket handling)
async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
  // Custom JSON-RPC parsing and handling
}

// After (MCPWebSocketServer)
import { MCPWebSocketServer } from "@mcp/websocket-server";

export class LumenizeServer extends MCPWebSocketServer {
  async handleToolCall(toolName: string, args: any, sessionId: string) {
    // Tool implementation
  }
  
  async onSessionConnected(sessionId: string) {
    // Session initialization
  }
}
```

### Deliverables
- Updated server implementation
- Migration documentation
- Performance testing and validation

---

## Phase 5: Documentation and Testing

### Objective
Complete the reference implementation with comprehensive documentation and testing.

### Tasks
1. **SEP Documentation Updates**
   - Update SEP with links to reference implementations
   - Add usage examples and best practices
   - Document migration paths from other transports

2. **Integration Testing**
   - End-to-end testing with client and server libraries
   - Reconnection scenario testing
   - Performance benchmarking

3. **Example Applications**
   - Simple chat application using MCP WebSocket transport
   - Tool-calling example with reconnection handling
   - Server deployment examples

4. **Community Preparation**
   - Prepare for SEP review process
   - Create presentation materials
   - Set up issue tracking and contribution guidelines

### Deliverables
- Complete SEP documentation
- Reference implementation examples
- Test suites and benchmarks
- Community engagement materials

---

## Implementation Notes

### Dependencies Management
- Ensure all phases maintain compatibility with existing MCP protocol versions
- Use semantic versioning for library releases
- Plan for breaking changes and migration paths

### Testing Strategy
- Unit tests for each library component
- Integration tests between client and server
- Stress testing for reconnection scenarios
- Compatibility testing with existing MCP implementations

### Security Considerations
- Review all session ID handling for security vulnerabilities
- Implement rate limiting and abuse prevention
- Security audit of WebSocket connection handling

### Performance Targets
- Sub-100ms reconnection times
- Support for 1000+ concurrent sessions per server instance
- Minimal memory overhead for session persistence
