/**
 * Node.js Client for Experiments
 * 
 * Handles WebSocket connection and batch measurements
 */

import { WebSocket } from 'ws';
import { fetchBillingMetrics } from './r2-billing.js';

/**
 * LEGACY: Poll for completion (deprecated - DO now sends totalTime directly)
 * 
 * This function is kept for backward compatibility but should not be used.
 * Modern experiments use msg.totalTime from batch-complete event.
 * 
 * @deprecated Use msg.totalTime from batch-complete message instead
 */

/**
 * Sleep for specified milliseconds
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run an experiment batch
 * 
 * @param {string} wsUrl - WebSocket URL (e.g., 'ws://localhost:8787')
 * @param {string} mode - Test mode
 * @param {number} count - Number of operations
 * @param {number} timeout - Timeout in ms (default: 60000)
 * @returns {Promise<Object>} Results
 */
export async function runBatch(wsUrl, mode, count, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let startTime;
    const progressUpdates = [];

    // Timeout handler
    const timeoutHandle = setTimeout(() => {
      ws.close();
      reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);

    ws.on('open', () => {
      // Send batch request (timing starts when DO sends 'timing-start')
      ws.send(JSON.stringify({
        action: 'run-batch',
        mode,
        count
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'timing-start') {
          // DO signals timing start - record on client side where Date.now() works
          startTime = Date.now();
        } else if (msg.type === 'timing-end') {
          // DO signals timing end (we'll calculate total when batch completes)
        } else if (msg.type === 'progress') {
          progressUpdates.push(msg);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ⏱️  Progress: ${msg.completed}/${msg.total} (${elapsed}s)`);
        } else if (msg.type === 'batch-complete') {
          clearTimeout(timeoutHandle);
          ws.close();
          
          console.log(`  ✅ Batch complete`);
          
          // Calculate totalTime on client side (where Date.now() actually advances!)
          const totalTime = Date.now() - startTime;
          
          const result = {
            mode: msg.mode,
            totalTime,
            avgPerOp: (totalTime / count).toFixed(2),
            completed: msg.completed,
            errors: msg.errors,
            errorMessages: msg.errorMessages,
            progressUpdates
          };
          resolve(result);
        } else if (msg.type === 'error') {
          clearTimeout(timeoutHandle);
          ws.close();
          reject(new Error(msg.error));
        }
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    ws.on('close', () => {
      clearTimeout(timeoutHandle);
    });
  });
}

/**
 * Connect to WebSocket and wait for ready
 * 
 * @param {string} wsUrl - WebSocket URL
 * @returns {Promise<WebSocket>}
 */
export function connectWebSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    
    ws.on('open', () => {
      resolve(ws);
    });
    
    ws.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Format and display results
 * 
 * @param {Object} results - Results from runBatch
 */
export function displayResults(results) {
  console.log(`\n${results.mode}:`);
  console.log(`  Latency (Client-measured):`);
  console.log(`    Total: ${results.totalTime}ms`);
  console.log(`    Avg: ${results.avgPerOp}ms per operation`);
  console.log(`  Completed: ${results.completed}/${results.completed + results.errors}`);
  
  if (results.billing) {
    console.log(`  Billing (R2 logs):`);
    console.log(`    Count: ${results.billing.count} log entries`);
    console.log(`    Avg Wall Time: ${results.billing.avgWallTimeMs}ms`);
    console.log(`    Avg CPU Time: ${results.billing.avgCPUTimeMs}ms`);
    console.log(`    Total Wall Time: ${results.billing.totalWallTimeMs}ms`);
    console.log(`    Total CPU Time: ${results.billing.totalCPUTimeMs}ms`);
  }
  
  if (results.errors > 0) {
    console.log(`  Errors: ${results.errors}`);
    results.errorMessages.slice(0, 5).forEach(msg => {
      console.log(`    - ${msg}`);
    });
    if (results.errorMessages.length > 5) {
      console.log(`    ... and ${results.errorMessages.length - 5} more`);
    }
  }
}

/**
 * Discover patterns from experiment server
 * 
 * @param {string} baseUrl - Base HTTP URL (e.g., 'http://localhost:8787')
 * @returns {Promise<Array>} Array of pattern objects
 */
async function discoverPatterns(baseUrl) {
  const response = await fetch(`${baseUrl}/patterns`);
  if (!response.ok) {
    throw new Error(`Failed to fetch patterns: ${response.statusText}`);
  }
  const data = await response.json();
  return data.patterns;
}

/**
 * Run all experiments and display comparison table
 * 
 * @param {string} baseUrl - Base HTTP URL (e.g., 'http://localhost:8787')
 * @param {number} operationCount - Number of operations per pattern
 * @param {Object} options - Optional configuration
 * @param {number} options.timeout - Timeout per batch in ms (default: 60000)
 * @param {boolean} options.withBilling - Include R2 billing analysis (default: false)
 * @param {string} options.scriptName - Script name for R2 log filtering (required if withBilling=true)
 */
export async function runAllExperiments(baseUrl, operationCount = 50, options = {}) {
  const timeout = options.timeout || 60000;
  const reverse = options.reverse || false;
  const wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
  
  console.log('\n🧪 Experiment Comparison');
  console.log('========================\n');
  console.log(`Target: ${wsUrl}`);
  console.log(`Operations: ${operationCount}`);
  if (reverse) {
    console.log(`Order: REVERSED (to test JIT effects)`);
  }
  console.log('');
  
  try {
    // Discover available patterns
    console.log('🔍 Discovering available patterns...');
    let patterns = await discoverPatterns(baseUrl);
    
    // Reverse order if requested
    if (reverse) {
      patterns = patterns.reverse();
    }
    
    console.log(`Found ${patterns.length} pattern(s):\n`);
    patterns.forEach(p => {
      console.log(`  • ${p.name} (${p.mode})`);
      console.log(`    ${p.description}`);
    });
    console.log('');
    
    // Warmup phase to eliminate cold-start overhead
    console.log('🔥 Warmup phase (eliminating cold starts)...');
    for (const pattern of patterns) {
      await runBatch(wsUrl, pattern.mode, 5, timeout);
    }
    await sleep(500); // Brief pause between warmup and real measurements
    console.log('');
    
    // Run batch for each pattern
    const results = [];
    for (const pattern of patterns) {
      console.log(`\n📊 Testing: ${pattern.name}`);
      const batchStart = Date.now();
      const result = await runBatch(wsUrl, pattern.mode, operationCount, timeout);
      const batchEnd = Date.now();
      
      results.push({
        ...pattern,
        ...result,
        batchWindow: { start: batchStart, end: batchEnd } // For R2 query
      });
    }
    
    // Fetch billing metrics if enabled
    if (options.withBilling) {
      if (!options.scriptName) {
        console.warn('\n⚠️  withBilling=true but no scriptName provided. Skipping billing analysis.');
      } else {
        console.log('\n💰 Fetching billing metrics from R2...');
        
        for (const result of results) {
          try {
            const billing = await fetchBillingMetrics(
              options.scriptName,
              result.batchWindow.start,
              result.batchWindow.end,
              operationCount
            );
            result.billing = billing;
          } catch (error) {
            console.error(`  ❌ Failed to fetch billing for ${result.mode}:`, error.message);
            result.billing = null;
          }
        }
      }
    }
    
    // Display comparison table
    console.log('\n\n📈 COMPARISON');
    console.log('=============\n');
    
    // Display each result
    results.forEach(result => {
      console.log(`${result.name} (${result.mode})`);
      console.log(`  ${result.description}`);
      displayResults(result);
      console.log('');
    });
    
    // Summary table
    if (results.every(r => r.errors === 0)) {
      console.log('\n📊 SUMMARY TABLE');
      console.log('================\n');
      
      const baseline = results[0];
      const baselineAvg = baseline.totalTime / baseline.completed;
      
      results.forEach(result => {
        const avg = result.totalTime / result.completed;
        const percentDiff = baseline === result ? 0 : ((avg - baselineAvg) / baselineAvg) * 100;
        const sign = percentDiff > 0 ? '+' : '';
        const percentStr = baseline === result ? '' : ` (${sign}${percentDiff.toFixed(0)}%)`;
        
        console.log(`${result.mode} - ${avg.toFixed(2)}ms/op${percentStr} - ${result.name}`);
      });
      
      console.log('\n✅ All patterns successful!\n');
    } else {
      console.log('⚠️  Some patterns had errors\n');
    }
    
    return results;
  } catch (error) {
    console.error('\n❌ Experiment failed:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}

