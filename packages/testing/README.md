# @lumenize/testing

Testing utilities for Lumenize applications and MCP servers.

## Installation

```bash
npm install @lumenize/testing
```

## Limitations

The WebSocket mock implementation has the following limitations compared to the browser WebSocket API:

#### **Missing Connection Metadata**
- `WebSocket.url` - Connection URL is not exposed
- `WebSocket.protocol` - Negotiated sub-protocol is not implemented  
- `WebSocket.extensions` - Extension negotiation (like `permessage-deflate` compression) is not simulated
- `WebSocket.binaryType` - Binary data handling mode is not implemented

#### **Simplified State Management**
- `readyState` transitions directly from `CONNECTING` (0) to `OPEN` (1) to `CLOSED` (3)
- `CLOSING` (2) state is skipped - close operations happen immediately
- State transitions are synchronous rather than following browser timing

#### **Limited Close Event Details**
- Close events don't include standard `CloseEvent` properties:
  - `code` - Close status code (1000, 1001, etc.)
  - `reason` - Human-readable close reason
  - `wasClean` - Whether the connection closed cleanly

#### **Simplified Error Handling**
- Error events lack detailed `ErrorEvent` properties
- No network-level error simulation (connection refused, timeout, etc.)
- Errors are basic objects rather than proper `ErrorEvent` instances

#### **Binary Data Limitations**
- Only string messages are supported in the current implementation
- `ArrayBuffer` and `Blob` message types are not implemented
- `bufferedAmount` property is always 0

#### **Protocol Limitations**
- Sub-protocol negotiation is not implemented
- Custom headers during handshake are not supported
- Origin validation is not performed

These limitations make the mock suitable for testing basic WebSocket functionality but may not cover all edge cases that real WebSocket connections encounter.

