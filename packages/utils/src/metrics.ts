/**
 * Simple metrics collector for performance testing.
 * 
 * A plain object where keys are metric names and values are counts, bytes, or timers (milliseconds).
 * This flexible structure allows tracking arbitrary metrics without defining them upfront.
 * 
 * ## Unified Metrics (cross-transport)
 * These metrics work consistently across HTTP and WebSocket transports:
 * - `roundTrips`: Number of network round trips (HTTP requests or WebSocket message pairs)
 * - `payloadBytesSent`: Total payload bytes sent
 * - `payloadBytesReceived`: Total payload bytes received
 * 
 * ## Transport-Specific Metrics
 * These provide additional detail for specific transports:
 * - `httpRequests`: HTTP request count
 * - `wsUpgradeRequests`: WebSocket connection establishment count
 * - `wsSentMessages`: WebSocket messages sent count
 * - `wsReceivedMessages`: WebSocket messages received count
 * - `wsSentPayloadBytes`: WebSocket payload bytes sent (deprecated - use payloadBytesSent)
 * - `wsReceivedPayloadBytes`: WebSocket payload bytes received (deprecated - use payloadBytesReceived)
 * 
 * @example
 * ```typescript
 * const metrics: Metrics = {};
 * 
 * // Unified metrics (work for both HTTP and WebSocket)
 * metrics.roundTrips = (metrics.roundTrips ?? 0) + 1;
 * metrics.payloadBytesSent = (metrics.payloadBytesSent ?? 0) + bytes;
 * metrics.payloadBytesReceived = (metrics.payloadBytesReceived ?? 0) + bytes;
 * 
 * // Transport-specific metrics
 * metrics.httpRequests = (metrics.httpRequests ?? 0) + 1;
 * metrics.wsUpgradeRequests = (metrics.wsUpgradeRequests ?? 0) + 1;
 * metrics.wsSentMessages = (metrics.wsSentMessages ?? 0) + 1;
 * metrics.wsReceivedMessages = (metrics.wsReceivedMessages ?? 0) + 1;
 * 
 * // Track timers (milliseconds)
 * const start = performance.now();
 * // ... do work ...
 * metrics.totalDuration = performance.now() - start;
 * 
 * console.log(metrics);
 * // { 
 * //   roundTrips: 52,
 * //   payloadBytesSent: 12847,
 * //   payloadBytesReceived: 11203,
 * //   httpRequests: 5, 
 * //   wsUpgradeRequests: 2, 
 * //   wsSentMessages: 47,
 * //   wsReceivedMessages: 47,
 * //   totalDuration: 234.5 
 * // }
 * ```
 */
export type Metrics = Record<string, number>;
