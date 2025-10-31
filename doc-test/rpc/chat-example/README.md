# Chat Example - Lumenize RPC Doc-Test

This is a comprehensive doc-test demonstrating all key features of Lumenize RPC:

- **Two-DO Architecture**: User DO acts as gateway to Room DO via Workers RPC
- **Downstream Messaging**: Server-to-client push notifications
- **Authentication**: Token-based auth with Workers KV, session expiration handling
- **Permission-Based Access**: Room manages per-user permissions
- **Type Support**: Maps, Dates, and complex objects preserved across the wire
- **Application-Layer Catchup**: Clients request missed messages after reconnect
- **Private Member Hiding**: Demonstrates RPC boundaries and security

## Running the Tests

```bash
npm test
```

## See Also

- [Lumenize RPC Documentation](https://lumenize.com/docs/rpc)
- [Design Document](../../../tasks/chat-example-doc-test.md)

