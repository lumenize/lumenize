import { DurableObject } from 'cloudflare:workers';

interface Env {
  EXPERIMENT_DO: DurableObjectNamespace;
}

/**
 * Sleep utility for experiments
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Experimental DO to test alarm and async behavior
 */
export class ExperimentDO extends DurableObject<Env> {
  /**
   * Experiment 1: Fire-and-forget async without waitUntil
   */
  async experiment1_noWaitUntil() {
    // Clear any previous results
    this.#clearResults();
    
    // Set alarm to trigger async work
    this.ctx.storage.setAlarm(Date.now() + 100);
    
    return { started: true };
  }
  
  /**
   * Experiment 2: Async with ctx.waitUntil()
   */
  async experiment2_withWaitUntil() {
    this.#clearResults();
    this.ctx.storage.setAlarm(Date.now() + 100);
    return { started: true };
  }
  
  /**
   * Experiment 3: Multiple parallel async operations
   */
  async experiment3_parallelOps() {
    this.#clearResults();
    this.ctx.storage.setAlarm(Date.now() + 100);
    return { started: true };
  }
  
  /**
   * Clear all results from storage
   */
  #clearResults() {
    const list = this.ctx.storage.kv.list({ prefix: 'completed-' });
    for (const [key] of list) {
      this.ctx.storage.kv.delete(key);
    }
  }
  
  /**
   * Alarm handler - routes to appropriate experiment
   */
  async alarm() {
    const experimentType = this.ctx.storage.kv.get('experiment-type');
    
    if (experimentType === 'experiment1') {
      await this.#alarm_experiment1_noWaitUntil();
    } else if (experimentType === 'experiment2') {
      await this.#alarm_experiment2_withWaitUntil();
    } else if (experimentType === 'experiment3') {
      await this.#alarm_experiment3_parallelOps();
    } else if (experimentType === 'experiment4') {
      await this.#alarm_experiment4_findFetchLimit();
    } else if (experimentType === 'experiment5') {
      await this.#alarm_experiment5_findQueueCapacity();
    }
  }
  
  /**
   * Experiment 1 alarm: Fire-and-forget (no waitUntil)
   */
  async #alarm_experiment1_noWaitUntil() {
    console.log('[Exp1] Alarm triggered');
    
    // Start 3 async operations WITHOUT await or waitUntil
    this.#doAsyncWork(1, 1000);
    this.#doAsyncWork(2, 1500);
    this.#doAsyncWork(3, 2000);
    
    console.log('[Exp1] Alarm completing (async ops fired but not awaited)');
    // Alarm completes - will async ops continue?
  }
  
  /**
   * Experiment 2 alarm: With ctx.waitUntil()
   */
  async #alarm_experiment2_withWaitUntil() {
    console.log('[Exp2] Alarm triggered');
    
    // Start async operations WITH ctx.waitUntil()
    this.ctx.waitUntil(this.#doAsyncWork(1, 1000));
    this.ctx.waitUntil(this.#doAsyncWork(2, 1500));
    this.ctx.waitUntil(this.#doAsyncWork(3, 2000));
    
    console.log('[Exp2] Alarm completing (async ops in waitUntil)');
  }
  
  /**
   * Experiment 3 alarm: Many parallel ops
   */
  async #alarm_experiment3_parallelOps() {
    console.log('[Exp3] Alarm triggered');
    
    // Start 10 parallel operations with waitUntil
    for (let i = 0; i < 10; i++) {
      this.ctx.waitUntil(this.#doAsyncWork(i, 500 + Math.random() * 1000));
    }
    
    console.log('[Exp3] Alarm completing (10 parallel ops started)');
  }
  
  /**
   * Simulated async work - sleeps then writes to storage
   */
  async #doAsyncWork(id: number, delayMs: number): Promise<void> {
    const startTime = Date.now();
    console.log(`[Work ${id}] Starting (delay: ${delayMs}ms)`);
    
    await sleep(delayMs);
    
    const endTime = Date.now();
    const actualDelay = endTime - startTime;
    
    console.log(`[Work ${id}] Completing (actual delay: ${actualDelay}ms)`);
    this.ctx.storage.kv.put(`completed-${id}`, {
      id,
      expectedDelay: delayMs,
      actualDelay,
      completedAt: endTime
    });
  }
  
  /**
   * Get results of experiment
   */
  async getResults() {
    const list = this.ctx.storage.kv.list({ prefix: 'completed-' });
    const results: any[] = [];
    
    for (const [key, data] of list) {
      results.push(data);
    }
    
    return {
      totalCompleted: results.length,
      results: results.sort((a, b) => a.id - b.id)
    };
  }
  
  /**
   * Set experiment type for alarm routing
   */
  async setExperimentType(type: string) {
    this.ctx.storage.kv.put('experiment-type', type);
  }
  
  /**
   * Experiment 4: Find the true parallel fetch limit
   * 
   * Strategy: Start many fetches to a slow endpoint and track which ones
   * are actually executing in parallel vs queued.
   */
  async experiment4_findFetchLimit() {
    this.#clearResults();
    this.ctx.storage.setAlarm(Date.now() + 100);
    return { started: true };
  }
  
  /**
   * Experiment 5: Find the pending fetch queue capacity
   * 
   * Strategy: Fire off many fetches and see when we get errors
   */
  async experiment5_findQueueCapacity() {
    this.#clearResults();
    this.ctx.storage.setAlarm(Date.now() + 100);
    return { started: true };
  }
  
  /**
   * Experiment 4 alarm: Measure parallel fetch limit
   */
  async #alarm_experiment4_findFetchLimit() {
    console.log('[Exp4] Finding parallel fetch limit...');
    
    // Start 20 fetches to httpbin.org/delay/3 (3 second delay)
    // Track when each one starts and completes
    const fetchCount = 20;
    const startTime = Date.now();
    
    for (let i = 0; i < fetchCount; i++) {
      this.ctx.waitUntil(this.#trackingFetch(i, startTime, 3));
    }
    
    console.log(`[Exp4] Initiated ${fetchCount} fetches`);
  }
  
  /**
   * Fetch with detailed timing tracking
   */
  async #trackingFetch(id: number, globalStart: number, delaySec: number): Promise<void> {
    const queuedAt = Date.now() - globalStart;
    console.log(`[Fetch ${id}] Queued at +${queuedAt}ms`);
    
    try {
      const fetchStart = Date.now();
      const actualStart = fetchStart - globalStart;
      console.log(`[Fetch ${id}] Starting actual fetch at +${actualStart}ms`);
      
      const response = await fetch(`https://httpbin.org/delay/${delaySec}`);
      
      const fetchEnd = Date.now();
      const actualDuration = fetchEnd - fetchStart;
      const overallTime = fetchEnd - globalStart;
      
      console.log(`[Fetch ${id}] Completed at +${overallTime}ms (fetch took ${actualDuration}ms)`);
      
      this.ctx.storage.kv.put(`fetch-${id}`, {
        id,
        queuedAt,          // When we called fetch()
        actualStart,       // When fetch actually started executing
        actualDuration,    // How long the fetch took
        overallTime,       // Total time from global start
        status: response.status
      });
    } catch (error) {
      const errorTime = Date.now() - globalStart;
      console.error(`[Fetch ${id}] Error at +${errorTime}ms:`, error instanceof Error ? error.message : String(error));
      
      this.ctx.storage.kv.put(`fetch-${id}`, {
        id,
        queuedAt,
        error: error instanceof Error ? error.message : String(error),
        errorTime
      });
    }
  }
  
  /**
   * Experiment 5 alarm: Test queue capacity
   */
  async #alarm_experiment5_findQueueCapacity() {
    console.log('[Exp5] Finding pending fetch queue capacity...');
    
    // Try to queue increasingly large numbers of fetches
    // Testing with 200 to see if we hit any limits
    const fetchCount = 200;
    const startTime = Date.now();
    let successCount = 0;
    let errorCount = 0;
    
    for (let i = 0; i < fetchCount; i++) {
      try {
        this.ctx.waitUntil(this.#quickFetch(i, startTime));
        successCount++;
      } catch (error) {
        errorCount++;
        console.error(`[Exp5] Failed to queue fetch ${i}:`, error instanceof Error ? error.message : String(error));
        this.ctx.storage.kv.put(`queue-error-${i}`, {
          id: i,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    
    this.ctx.storage.kv.put('queue-stats', {
      total: fetchCount,
      queued: successCount,
      errors: errorCount
    });
    
    console.log(`[Exp5] Queued ${successCount} fetches, ${errorCount} errors`);
  }
  
  /**
   * Quick fetch to a fast endpoint for capacity testing
   */
  async #quickFetch(id: number, globalStart: number): Promise<void> {
    try {
      const response = await fetch('https://httpbin.org/uuid');
      const endTime = Date.now() - globalStart;
      
      this.ctx.storage.kv.put(`quick-${id}`, {
        id,
        completedAt: endTime,
        status: response.status
      });
    } catch (error) {
      this.ctx.storage.kv.put(`quick-${id}`, {
        id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  
  /**
   * Get fetch timing analysis (for Experiment 4)
   */
  async getFetchTimingAnalysis() {
    const list = this.ctx.storage.kv.list({ prefix: 'fetch-' });
    const fetches: any[] = [];
    
    for (const [key, data] of list) {
      fetches.push(data);
    }
    
    fetches.sort((a, b) => a.id - b.id);
    
    // Analyze parallelism: group by start time windows
    const windowMs = 100; // 100ms windows
    const windows = new Map<number, number>();
    
    for (const f of fetches) {
      if (f.actualStart !== undefined) {
        const window = Math.floor(f.actualStart / windowMs);
        windows.set(window, (windows.get(window) || 0) + 1);
      }
    }
    
    // Find maximum concurrent fetches (peak of any window)
    const maxConcurrent = Math.max(...Array.from(windows.values()));
    
    return {
      totalFetches: fetches.length,
      fetches,
      maxConcurrent,
      windows: Array.from(windows.entries()).map(([w, count]) => ({
        timeRange: `${w * windowMs}-${(w + 1) * windowMs}ms`,
        count
      }))
    };
  }
  
  /**
   * Get queue capacity results (for Experiment 5)
   */
  async getQueueCapacityResults() {
    const stats = this.ctx.storage.kv.get('queue-stats');
    
    // Collect all quick- results
    const quickList = this.ctx.storage.kv.list({ prefix: 'quick-' });
    const completed: any[] = [];
    for (const [key, data] of quickList) {
      completed.push(data);
    }
    
    // Collect all queue-error- results
    const errorList = this.ctx.storage.kv.list({ prefix: 'queue-error-' });
    const errors: any[] = [];
    for (const [key, data] of errorList) {
      errors.push(data);
    }
    
    return {
      stats,
      completedCount: completed.length,
      errorCount: errors.length,
      errors
    };
  }
}

/**
 * Worker export
 */
export default {
  fetch(): Response {
    return new Response('Experiment worker - use DO methods for experiments');
  }
} satisfies ExportedHandler<Env>;
