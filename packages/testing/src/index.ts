// Main export - testing-optimized RPC client
export { createTestingClient } from './create-testing-client';

// DO project instrumentation
export { instrumentDOProject } from './instrument-do-project';
export type { InstrumentDOProjectConfig, InstrumentedDOProject } from './instrument-do-project';

// Re-export RPC functionality for downstream messaging
export { sendDownstream } from '@lumenize/rpc';

// Re-export RPC types that are commonly needed in tests
export type { RpcAccessible, RpcClientProxy } from '@lumenize/rpc';

// Browser — cookie-aware HTTP/WebSocket client for testing and scripting
export { Browser, Context, type BrowserOptions } from './browser';

// WebSocket shim for Cloudflare Workers test environments
export { getWebSocketShim, type WebSocketShimOptions } from './websocket-shim';

// Metrics type for performance tracking
export type { Metrics } from './metrics';
