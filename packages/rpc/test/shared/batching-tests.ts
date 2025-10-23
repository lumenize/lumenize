/**
 * Batching-specific behavior tests
 * 
 * These tests verify that the RPC client properly batches operations in the same tick
 * into a single network request. They use the unified `roundTrips` metric which works
 * consistently across both HTTP and WebSocket transports.
 */

import { expect } from 'vitest';
import type { Metrics } from '@lumenize/utils';
import type { RpcAccessible } from '../../src/types';

/**
 * Interface for testable clients with metrics support
 */
export interface TestableClientWithMetrics<T = any> {
  client: RpcAccessible<T>;
  metrics: Metrics;
  cleanup?: () => void | Promise<void>;
}

/**
 * Type for batching test functions
 */
export type BatchingTest<T = any> = (testable: TestableClientWithMetrics<T>) => Promise<void>;

/**
 * Verify multiple operations in same tick get batched into single request
 */
export async function testBatchMultipleOperationsSameTick(testable: TestableClientWithMetrics): Promise<void> {
  const { client, metrics } = testable;
  
  // Make a dummy call to establish connection first (for WebSocket)
  await (client as any).add(0, 0);
  
  // Record roundTrips after connection is established
  const roundTripsBefore = metrics.roundTrips ?? 0;
  
  // Fire 3 operations in same tick (no await between them)
  const promise1 = (client as any).increment();
  const promise2 = (client as any).increment();
  const promise3 = (client as any).increment();
  
  // Now await all results
  const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);
  
  // Verify results are correct
  expect(result1).toBe(1);
  expect(result2).toBe(2);
  expect(result3).toBe(3);
  
  // Verify batching happened - delta should be 1 round trip
  const roundTripsAfter = metrics.roundTrips ?? 0;
  expect(roundTripsAfter - roundTripsBefore).toBe(1);
}

/**
 * Verify operations across different ticks result in separate batches
 */
export async function testSeparateBatchesAcrossTicks(testable: TestableClientWithMetrics): Promise<void> {
  const { client, metrics } = testable;
  
  // Make a dummy call to establish connection first (for WebSocket)
  await (client as any).add(0, 0);
  
  // Record roundTrips after connection is established
  const roundTripsBefore = metrics.roundTrips ?? 0;
  
  // First operation - await it
  const result1 = await (client as any).increment();
  expect(result1).toBe(1);
  
  const roundTripsAfterFirst = (metrics.roundTrips ?? 0) - roundTripsBefore;
  
  // Second operation - await it
  const result2 = await (client as any).increment();
  expect(result2).toBe(2);
  
  const roundTripsAfterSecond = (metrics.roundTrips ?? 0) - roundTripsBefore;
  
  // Verify we made 2 separate round trips (delta should be 2)
  expect(roundTripsAfterFirst).toBe(1);
  expect(roundTripsAfterSecond).toBe(2);
}

/**
 * Verify mixed operations in same tick get batched correctly
 */
export async function testBatchMixedOperations(testable: TestableClientWithMetrics): Promise<void> {
  const { client, metrics } = testable;
  
  // Make a dummy call to establish connection first (for WebSocket)
  await (client as any).add(0, 0);
  
  // Record roundTrips after connection is established
  const roundTripsBefore = metrics.roundTrips ?? 0;
  
  // Fire 4 different operations in same tick
  const promise1 = (client as any).increment();
  const promise2 = (client as any).add(5, 3);
  const promise3 = (client as any).increment();
  const promise4 = (client as any).getArray();
  
  // Await all results
  const [result1, result2, result3, result4] = await Promise.all([promise1, promise2, promise3, promise4]);
  
  // Verify results
  expect(result1).toBe(1);
  expect(result2).toBe(8);
  expect(result3).toBe(2);
  expect(result4).toEqual([1, 2, 3, 4, 5]);
  
  // Verify batching - all 4 operations in single round trip (delta should be 1)
  const roundTripsAfter = metrics.roundTrips ?? 0;
  expect(roundTripsAfter - roundTripsBefore).toBe(1);
}

/**
 * Verify large batch (many operations in same tick)
 */
export async function testLargeBatch(testable: TestableClientWithMetrics): Promise<void> {
  const { client, metrics } = testable;
  
  // Make a dummy call to establish connection first (for WebSocket)
  await (client as any).add(0, 0);
  
  // Record roundTrips after connection is established
  const roundTripsBefore = metrics.roundTrips ?? 0;
  
  // Fire 20 operations in same tick
  const promises = Array.from({ length: 20 }, () => (client as any).increment());
  
  // Await all results
  const results = await Promise.all(promises);
  
  // Verify all results are in sequence
  expect(results).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  
  // Verify batching - delta should be 1 round trip for all 20 operations
  const roundTripsAfter = metrics.roundTrips ?? 0;
  expect(roundTripsAfter - roundTripsBefore).toBe(1);
}

/**
 * Verify batch with mixed success/failure preserves correct error routing
 */
export async function testBatchWithErrors(testable: TestableClientWithMetrics): Promise<void> {
  const { client, metrics } = testable;
  
  // Make a dummy call to establish connection first (for WebSocket)
  await (client as any).add(0, 0);
  
  // Record roundTrips after connection is established
  const roundTripsBefore = metrics.roundTrips ?? 0;
  
  // Fire operations where some will fail
  const promise1 = (client as any).increment();
  const promise2 = (client as any).throwError('test error');
  const promise3 = (client as any).increment();
  
  // Await results individually to handle errors
  const result1 = await promise1;
  expect(result1).toBe(1);
  
  await expect(promise2).rejects.toThrow('test error');
  
  const result3 = await promise3;
  expect(result3).toBe(2);
  
  // Verify all operations were in single batch (delta should be 1 round trip)
  const roundTripsAfter = metrics.roundTrips ?? 0;
  expect(roundTripsAfter - roundTripsBefore).toBe(1);
}

/**
 * All batching tests in a registry
 */
export const batchingTests = {
  batchMultipleOperationsSameTick: testBatchMultipleOperationsSameTick,
  separateBatchesAcrossTicks: testSeparateBatchesAcrossTicks,
  batchMixedOperations: testBatchMixedOperations,
  largeBatch: testLargeBatch,
  batchWithErrors: testBatchWithErrors,
};
