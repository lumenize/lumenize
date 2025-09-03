# @lumenize/testing

Testing utilities for Lumenize applications and MCP servers.

## Features

- **Mock Connection Factory**: Create mock WebSocket connections for testing MCP protocol interactions
- **Test Server Utilities**: Check server availability and create conditional test runners
- **Message Builders**: Convenient builders for MCP protocol messages (initialize, tool calls, notifications, etc.)
- **Response Validators**: Standard expectation helpers for validating MCP responses
- **Integration Test Helpers**: Run full client-server integration tests with WebSocket proxying
- **Lumenize Test Runner**: Simplified test runner for Lumenize Durable Objects with automatic MCP initialization

## Installation

```bash
npm install @lumenize/testing
```

## Usage

### Basic Mock Connection Testing

```typescript
import { createMockConnection, MessageBuilders, ExpectedResponses } from '@lumenize/testing';

// Create a mock connection
const mock = createMockConnection();

// Send MCP messages
const initMessage = MessageBuilders.initialize();
await instance.onMessage(mock.connection, initMessage);

// Validate responses
const response = mock.getLastMessage();
const data = JSON.parse(response);
ExpectedResponses.initialize(data);
```

### Conditional Testing Based on Server Availability

```typescript
import { checkServerAvailability, createMaybeIt } from '@lumenize/testing';

const serverAvailable = await checkServerAvailability();
const maybeIt = createMaybeIt(serverAvailable);

maybeIt("should call live API", async () => {
  // This test only runs if server is available
});
```

### Lumenize Durable Object Testing

```typescript
import { runTestWithLumenize } from '@lumenize/testing';

await runTestWithLumenize(async (instance, mock, state) => {
  // Test is automatically initialized with MCP protocol
  // Send tool calls, check notifications, etc.
});
```

### Integration Testing

```typescript
import { runClientServerIntegrationTest } from '@lumenize/testing';

await runClientServerIntegrationTest(async (client) => {
  // Test with real LumenizeClient connected to server
  const tools = await client.listTools();
  expect(tools).toBeDefined();
});
```

## API Reference

### Mock Connection

- `createMockConnection()` - Creates a mock WebSocket connection with message tracking
- `mock.getSentMessages()` - Get all sent messages
- `mock.getLastMessage()` - Get the most recent message
- `mock.getMessageById(id)` - Get message by JSON-RPC ID
- `mock.waitForNotification(entityUri?)` - Wait for specific notifications

### Message Builders

- `MessageBuilders.initialize(id?, protocolVersion?, clientInfo?)` - MCP initialize message
- `MessageBuilders.toolsList(id?)` - List tools request
- `MessageBuilders.toolCall(id?, name?, args?)` - Tool call request
- `MessageBuilders.notification(method?, params?)` - Notification message

### Response Validators

- `ExpectedResponses.initialize(data, id?)` - Validate initialize response
- `ExpectedResponses.toolsList(data, id?)` - Validate tools list response
- `ExpectedResponses.toolCall(data, id?)` - Validate tool call response
- `ExpectedResponses.error(data, code, id?)` - Validate error response

### Server Utilities

- `checkServerAvailability()` - Check if test server is running
- `createMaybeIt(serverAvailable)` - Create conditional test runner
- `monkeyPatchWebSocketForTesting()` - Patch WebSocket for cookie injection

## License

BSL-1.1
