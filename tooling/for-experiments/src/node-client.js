/**
 * Node.js Client for Experiments
 * 
 * Handles WebSocket connection and batch measurements
 */

import { WebSocket } from 'ws';

/**
 * Poll for completion of the last operation via RPC
 * 
 * @param {string} wsUrl - WebSocket URL (converted to HTTP for RPC)
 * @param {string} mode - Test mode
 * @param {number} lastIndex - Index of last operation (count - 1)
 * @param {number} startTime - When batch started
 * @param {number} timeout - Max time to wait
 * @returns {Promise<number>} Total time elapsed
 */
async function pollForCompletion(wsUrl, mode, lastIndex, startTime, timeout) {
  // Convert ws:// to http:// for RPC calls
  const httpUrl = wsUrl.replace('ws://', 'http://').replace('wss://', 'https://');
  const baseUrl = httpUrl.replace(/\/$/, ''); // Remove trailing slash
  
  const maxAttempts = 50; // 5 seconds max (100ms * 50)
  
  console.log(`  🔍 Polling for completion of ${mode}[${lastIndex}]...`);
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check if we've exceeded total timeout
    if (Date.now() - startTime > timeout) {
      throw new Error(`Timeout waiting for completion after ${timeout}ms`);
    }
    
    try {
      // Make RPC call to check if last operation completed
      const response = await fetch(`${baseUrl}/rpc/checkCompletion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, index: lastIndex })
      });
      
      if (!response.ok) {
        throw new Error(`RPC call failed: ${response.status}`);
      }
      
      const isComplete = await response.json();
      
      if (isComplete) {
        // Last operation completed! Return total time
        console.log(`  ✅ Completion confirmed after ${attempt + 1} poll(s)`);
        return Date.now() - startTime;
      }
      
      // Log every 10 attempts
      if ((attempt + 1) % 10 === 0) {
        console.log(`  ⏳ Still polling... (attempt ${attempt + 1}/${maxAttempts})`);
      }
    } catch (error) {
      console.warn(`  ⚠️  Poll attempt ${attempt + 1} failed:`, error.message);
    }
    
    // Wait 100ms before next check
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  throw new Error(`Last operation did not complete after ${maxAttempts} polling attempts`);
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
      // Send batch request and start client-side timing
      startTime = Date.now();
      ws.send(JSON.stringify({
        action: 'run-batch',
        mode,
        count
      }));
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'progress') {
          progressUpdates.push(msg);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ⏱️  Progress: ${msg.completed}/${msg.total} (${elapsed}s)`);
        } else if (msg.type === 'batch-complete') {
          clearTimeout(timeoutHandle);
          ws.close();
          
          console.log(`  📡 Batch signaled complete, polling for actual completion...`);
          
          // Poll for completion of last operation (client-side polling)
          pollForCompletion(wsUrl, mode, count - 1, startTime, timeout)
            .then((totalTime) => {
              const result = {
                mode: msg.mode,
                totalTime: totalTime,
                avgPerOp: (totalTime / count).toFixed(2),
                completed: msg.completed,
                errors: msg.errors,
                errorMessages: msg.errorMessages,
                progressUpdates
              };
              resolve(result);
            })
            .catch((error) => {
              console.error(`  ❌ Polling failed:`, error.message);
              reject(error);
            });
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
  console.log(`  Total: ${results.totalTime}ms`);
  console.log(`  Avg: ${results.avgPerOp}ms per operation`);
  console.log(`  Completed: ${results.completed}/${results.completed + results.errors}`);
  
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
    
    // Run batch for each pattern
    const results = [];
    for (const pattern of patterns) {
      console.log(`\n📊 Testing: ${pattern.name}`);
      const result = await runBatch(wsUrl, pattern.mode, operationCount, timeout);
      results.push({
        ...pattern,
        ...result
      });
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

