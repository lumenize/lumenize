#!/usr/bin/env node
/**
 * Scalability Test for proxyFetchWorker
 * 
 * Tests concurrent fetch performance to find the linear scalability tipping point.
 * 
 * Strategy:
 * 1. Start with 10 concurrent fetches
 * 2. If linear (~10x single fetch), try 100
 * 3. If still linear (~100x), try 1000
 * 4. Zero in on tipping point when non-linear behavior appears
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .dev.vars from root
function loadDevVars() {
  try {
    const devVarsPath = join(__dirname, '../../../.dev.vars');
    const content = readFileSync(devVarsPath, 'utf-8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length) {
          process.env[key.trim()] = valueParts.join('=').trim();
        }
      }
    });
  } catch (error) {
    console.warn('⚠️  Could not load .dev.vars:', error.message);
  }
}

loadDevVars();

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');
const TEST_TOKEN = process.env.TEST_TOKEN;
const TEST_ENDPOINTS_URL = process.env.TEST_ENDPOINTS_URL;

if (!TEST_TOKEN || !TEST_ENDPOINTS_URL) {
  console.error('❌ Missing TEST_TOKEN or TEST_ENDPOINTS_URL in .dev.vars');
  process.exit(1);
}

const TARGET_URL = `${TEST_ENDPOINTS_URL}/latency-test/uuid?token=${TEST_TOKEN}`;

console.log('🚀 ProxyFetchWorker Scalability Test');
console.log('=====================================\n');
console.log('Connecting to:', BASE_URL);
console.log('WebSocket URL:', WS_URL);
console.log('Target:', TARGET_URL);
console.log('\n');

/**
 * Connect to WebSocket and wait for connection
 */
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('✓ WebSocket connected to Origin DO\n');
      resolve(ws);
    };
    
    ws.onerror = (error) => {
      reject(error);
    };
  });
}

/**
 * Run a batch test with N concurrent fetches
 */
async function runBatchTest(ws, count) {
  return new Promise((resolve, reject) => {
    const batchId = `batch-${Date.now()}-${count}`;
    const clientStartTime = Date.now();
    let dispatchConfirmed = false;
    
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      
      if (msg.type === 'batch-started' && msg.batchId === batchId) {
        dispatchConfirmed = true;
        const dispatchTime = Date.now() - clientStartTime;
        console.log(`  ✓ Dispatched ${count} fetches in ${dispatchTime}ms`);
      } else if (msg.type === 'batch-complete' && msg.batchId === batchId) {
        const totalTime = Date.now() - clientStartTime;
        
        // Remove listener
        ws.removeEventListener('message', onMessage);
        
        resolve({
          count,
          totalTime,
          successCount: msg.successCount
        });
      } else if (msg.type === 'error') {
        ws.removeEventListener('message', onMessage);
        reject(new Error(msg.error));
      }
    };
    
    ws.addEventListener('message', onMessage);
    
    // Send batch request
    ws.send(JSON.stringify({
      type: 'start-batch-fetch',
      batchId,
      count,
      url: TARGET_URL
    }));
    
    // Timeout after 120s (for large batches)
    setTimeout(() => {
      ws.removeEventListener('message', onMessage);
      reject(new Error(`Timeout waiting for batch ${batchId}`));
    }, 120000);
  });
}

/**
 * Calculate if scaling is linear
 */
function analyzeScaling(baseline, current) {
  const expectedTime = baseline.totalTime * (current.count / baseline.count);
  const actualTime = current.totalTime;
  const ratio = actualTime / expectedTime;
  const percentDiff = ((ratio - 1) * 100).toFixed(1);
  
  return {
    expected: Math.round(expectedTime),
    actual: actualTime,
    ratio: ratio.toFixed(2),
    percentDiff: percentDiff + '%',
    isLinear: ratio < 1.2 // Within 20% is considered linear
  };
}

/**
 * Main test sequence
 */
async function main() {
  const ws = await connectWebSocket();
  const results = [];
  
  // Test sequence
  const testSizes = [10, 100, 1000, 2000];
  
  for (const size of testSizes) {
    console.log(`📊 Testing ${size} concurrent fetches...`);
    
    try {
      const result = await runBatchTest(ws, size);
      results.push(result);
      
      console.log(`  ✓ Complete: ${result.totalTime}ms total (measured by client)`);
      console.log(`  → Success: ${result.successCount}/${result.count}\n`);
      
      // Analyze scaling if we have baseline
      if (results.length > 1) {
        const baseline = results[0];
        const scaling = analyzeScaling(baseline, result);
        
        console.log(`  📈 Scaling Analysis (vs ${baseline.count} concurrent):`);
        console.log(`    Expected (linear): ${scaling.expected}ms`);
        console.log(`    Actual: ${scaling.actual}ms`);
        console.log(`    Ratio: ${scaling.ratio}x`);
        console.log(`    Difference: ${scaling.percentDiff}`);
        console.log(`    Status: ${scaling.isLinear ? '✅ LINEAR' : '⚠️  NON-LINEAR'}\n`);
      }
      
      // Small delay between tests
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error(`  ❌ Error:`, error.message);
      break;
    }
  }
  
  ws.close();
  
  console.log('✅ Scalability test complete!\n');
  console.log('Summary:');
  results.forEach(r => {
    const perFetch = Math.round(r.totalTime / r.count);
    console.log(`  ${r.count} concurrent: ${r.totalTime}ms total (~${perFetch}ms per fetch if linear)`);
  });
}

main().catch(console.error);

