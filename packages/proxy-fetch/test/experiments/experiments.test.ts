/**
 * Experiments to understand alarm and async behavior in Durable Objects
 * 
 * These tests explore how alarms interact with async operations to determine
 * the correct pattern for parallel fetch processing in ProxyFetchDO.
 */

import { env } from 'cloudflare:test';
import { describe, test, expect, beforeEach } from 'vitest';

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('Alarm and Async Behavior Experiments', () => {
  let stub: any;
  
  beforeEach(async () => {
    stub = env.EXPERIMENT_DO.getByName('experiments');
  });
  
  test('Experiment 1: Fire-and-forget async WITHOUT ctx.waitUntil()', async () => {
    console.log('\n=== EXPERIMENT 1: No waitUntil ===');
    
    // Set experiment type and start
    await stub.setExperimentType('experiment1');
    const start = await stub.experiment1_noWaitUntil();
    expect(start.started).toBe(true);
    
    // Wait for async ops to complete (if they do)
    console.log('Waiting 3 seconds for async operations...');
    await sleep(3000);
    
    // Check results
    const results = await stub.getResults();
    console.log('Results:', results);
    
    // If async ops completed, we should have 3 results
    // If they were cancelled when alarm completed, we'll have 0
    console.log(`Completed ${results.totalCompleted} out of 3 operations`);
    
    // Document the behavior (don't assert - just observe)
    expect(results.totalCompleted).toBeGreaterThanOrEqual(0);
    expect(results.totalCompleted).toBeLessThanOrEqual(3);
  }, 10000);
  
  test('Experiment 2: Async WITH ctx.waitUntil()', async () => {
    console.log('\n=== EXPERIMENT 2: With waitUntil ===');
    
    await stub.setExperimentType('experiment2');
    const start = await stub.experiment2_withWaitUntil();
    expect(start.started).toBe(true);
    
    console.log('Waiting 3 seconds for async operations...');
    await sleep(3000);
    
    const results = await stub.getResults();
    console.log('Results:', results);
    
    console.log(`Completed ${results.totalCompleted} out of 3 operations`);
    
    expect(results.totalCompleted).toBeGreaterThanOrEqual(0);
    expect(results.totalCompleted).toBeLessThanOrEqual(3);
  }, 10000);
  
  test('Experiment 3: Multiple parallel operations with waitUntil', async () => {
    console.log('\n=== EXPERIMENT 3: 10 Parallel Ops ===');
    
    await stub.setExperimentType('experiment3');
    const start = await stub.experiment3_parallelOps();
    expect(start.started).toBe(true);
    
    console.log('Waiting 3 seconds for async operations...');
    await sleep(3000);
    
    const results = await stub.getResults();
    console.log('Results:', results);
    console.log(`Completed ${results.totalCompleted} out of 10 operations`);
    
    // Show timing info if any completed
    if (results.results.length > 0) {
      console.log('Timing details:');
      results.results.forEach((r: any) => {
        console.log(`  Op ${r.id}: expected ${r.expectedDelay}ms, actual ${r.actualDelay}ms`);
      });
    }
    
    expect(results.totalCompleted).toBeGreaterThanOrEqual(0);
    expect(results.totalCompleted).toBeLessThanOrEqual(10);
  }, 10000);
  
  test('Summary: What did we learn?', async () => {
    console.log('\n=== SUMMARY ===');
    console.log('Run the experiments above and observe:');
    console.log('1. Do async ops complete without waitUntil?');
    console.log('2. Do async ops complete with waitUntil?');
    console.log('3. Can we run many parallel ops successfully?');
    console.log('');
    console.log('This will tell us the right pattern for ProxyFetchDO.');
  });
});

describe('Cloudflare Fetch Limits Discovery', () => {
  let stub: any;
  
  beforeEach(async () => {
    stub = env.EXPERIMENT_DO.getByName('fetch-limits');
  });
  
  test('Experiment 4: Find true parallel fetch limit', async () => {
    console.log('\n=== EXPERIMENT 4: Parallel Fetch Limit ===');
    console.log('Starting 20 fetches to httpbin.org/delay/3...');
    console.log('If limit is 6, we should see batches of ~6 starting together');
    
    await stub.setExperimentType('experiment4');
    const start = await stub.experiment4_findFetchLimit();
    expect(start.started).toBe(true);
    
    // Wait for all fetches to complete (20 * 3 sec / 6 concurrent = ~10 seconds)
    console.log('Waiting 15 seconds for all fetches to complete...');
    await sleep(15000);
    
    const analysis = await stub.getFetchTimingAnalysis();
    console.log('\n=== ANALYSIS ===');
    console.log(`Total fetches: ${analysis.totalFetches}`);
    console.log(`Max concurrent (estimated): ${analysis.maxConcurrent}`);
    console.log('\nFetch start times:');
    
    // Group fetches by approximate start time
    const startGroups = new Map<string, number[]>();
    for (const f of analysis.fetches) {
      if (f.actualStart !== undefined) {
        const bucket = Math.floor(f.actualStart / 1000) * 1000; // 1-second buckets
        const key = `${bucket / 1000}s`;
        if (!startGroups.has(key)) {
          startGroups.set(key, []);
        }
        startGroups.get(key)!.push(f.id);
      }
    }
    
    for (const [time, ids] of Array.from(startGroups.entries()).sort()) {
      console.log(`  ${time}: ${ids.length} fetches started (IDs: ${ids.join(', ')})`);
    }
    
    console.log('\nDetailed timing (first 10 fetches):');
    analysis.fetches.slice(0, 10).forEach((f: any) => {
      if (f.actualStart !== undefined) {
        console.log(`  Fetch ${f.id}: queued at +${f.queuedAt}ms, started at +${f.actualStart}ms, took ${f.actualDuration}ms`);
      }
    });
    
    console.log(`\n🔍 CONCLUSION: Maximum concurrent fetches appears to be ~${analysis.maxConcurrent}`);
    
    // The test passes regardless - we're just observing
    expect(analysis.totalFetches).toBeGreaterThan(0);
  }, 20000);
  
  test('Experiment 5: Find pending fetch queue capacity', async () => {
    console.log('\n=== EXPERIMENT 5: Queue Capacity ===');
    console.log('Attempting to queue 100 fetches...');
    
    await stub.setExperimentType('experiment5');
    const start = await stub.experiment5_findQueueCapacity();
    expect(start.started).toBe(true);
    
    // Wait for fetches to complete
    console.log('Waiting 10 seconds for fetches to complete...');
    await sleep(10000);
    
    const results = await stub.getQueueCapacityResults();
    console.log('\n=== RESULTS ===');
    console.log(`Attempted to queue: ${results.stats?.total || 0} fetches`);
    console.log(`Successfully queued: ${results.stats?.queued || 0}`);
    console.log(`Queue errors: ${results.stats?.errors || 0}`);
    console.log(`Completed fetches: ${results.completedCount}`);
    
    if (results.errors.length > 0) {
      console.log('\nErrors encountered:');
      results.errors.slice(0, 5).forEach((e: any) => {
        console.log(`  Fetch ${e.id}: ${e.error}`);
      });
    }
    
    console.log(`\n🔍 CONCLUSION: Can queue at least ${results.stats?.queued || 0} fetches`);
    if (results.stats?.errors > 0) {
      console.log(`   Queue capacity limit hit at ~${results.stats.queued} pending fetches`);
    } else {
      console.log('   No queue capacity limit hit (may be higher than 100)');
    }
    
    expect(results.completedCount).toBeGreaterThan(0);
  }, 15000);
});
