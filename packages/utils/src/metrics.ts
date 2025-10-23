/**
 * Simple metrics collector for performance testing.
 * 
 * A plain object where keys are metric names and values are counts, bytes, or timers (milliseconds).
 * This flexible structure allows tracking arbitrary metrics without defining them upfront.
 * 
 * @example
 * ```typescript
 * const metrics: Metrics = {};
 * 
 * // Track counts
 * metrics.httpRequests = (metrics.httpRequests ?? 0) + 1;
 * metrics.wsUpgradeRequests = (metrics.wsUpgradeRequests ?? 0) + 1;
 * metrics.wsSentMessages = (metrics.wsSentMessages ?? 0) + 1;
 * metrics.wsReceivedMessages = (metrics.wsReceivedMessages ?? 0) + 1;
 * 
 * // Track bytes
 * metrics.wsSentPayloadBytes = (metrics.wsSentPayloadBytes ?? 0) + messageBytes;
 * metrics.wsReceivedPayloadBytes = (metrics.wsReceivedPayloadBytes ?? 0) + messageBytes;
 * 
 * // Track timers (milliseconds)
 * const start = performance.now();
 * // ... do work ...
 * metrics.totalDuration = performance.now() - start;
 * 
 * console.log(metrics);
 * // { 
 * //   httpRequests: 5, 
 * //   wsUpgradeRequests: 2, 
 * //   wsSentMessages: 47,
 * //   wsReceivedMessages: 47,
 * //   wsSentPayloadBytes: 12847,
 * //   wsReceivedPayloadBytes: 11203,
 * //   totalDuration: 234.5 
 * // }
 * ```
 */
export type Metrics = Record<string, number>;
