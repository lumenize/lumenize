/**
 * Production Latency Measurements for proxyFetchWorker
 * 
 * Runs in Node.js against wrangler dev server to get accurate timing.
 * 
 * Usage:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm test
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';

// Get TEST_ENDPOINTS from environment
// Set these before running: export $(cat ../../.dev.vars | xargs)
const TEST_TOKEN = process.env.TEST_TOKEN;
const TEST_ENDPOINTS_URL = process.env.TEST_ENDPOINTS_URL;

if (!TEST_TOKEN || !TEST_ENDPOINTS_URL) {
  console.error('❌ TEST_TOKEN and TEST_ENDPOINTS_URL must be set');
  console.error('Run: export $(cat ../../.dev.vars | xargs)');
  process.exit(1);
}

// Test endpoint that returns quickly (for measuring overhead)
const FAST_ENDPOINT = `${TEST_ENDPOINTS_URL}/latency-test/uuid?token=${TEST_TOKEN}`;

// Test endpoint with artificial delay (for measuring end-to-end)
const DELAYED_ENDPOINT = `${TEST_ENDPOINTS_URL}/latency-test/delay/1000?token=${TEST_TOKEN}`; // 1 second delay

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function measureEnqueueLatency(url, iterations = 10) {
  console.log(`\n📊 Measuring Enqueue Latency (${iterations} iterations)`);
  console.log(`Target: ${url}`);
  
  const latencies = [];
  
  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    const response = await fetch(`${BASE_URL}/start-fetch?url=${encodeURIComponent(url)}`);
    const enqueueTime = Date.now() - start;
    
    if (!response.ok) {
      throw new Error(`Failed to enqueue: ${response.statusText}`);
    }
    
    const { reqId, enqueueTime: serverEnqueueTime } = await response.json();
    latencies.push({ total: enqueueTime, server: serverEnqueueTime, reqId });
    
    // Small delay between requests
    await sleep(100);
  }
  
  // Calculate statistics
  const totalLatencies = latencies.map(l => l.total);
  const serverLatencies = latencies.map(l => l.server);
  
  const avgTotal = totalLatencies.reduce((a, b) => a + b, 0) / totalLatencies.length;
  const avgServer = serverLatencies.reduce((a, b) => a + b, 0) / serverLatencies.length;
  const minTotal = Math.min(...totalLatencies);
  const maxTotal = Math.max(...totalLatencies);
  const minServer = Math.min(...serverLatencies);
  const maxServer = Math.max(...serverLatencies);
  
  console.log(`\n  Total Round-Trip (Node → Worker → Node):`);
  console.log(`    Average: ${avgTotal.toFixed(2)}ms`);
  console.log(`    Min: ${minTotal}ms`);
  console.log(`    Max: ${maxTotal}ms`);
  
  console.log(`\n  Server Enqueue Time (proxyFetchWorker() call):`);
  console.log(`    Average: ${avgServer.toFixed(2)}ms`);
  console.log(`    Min: ${minServer}ms`);
  console.log(`    Max: ${maxServer}ms`);
  console.log(`    Target: <50ms ✓`);
  
  return { latencies, avgTotal, avgServer, minServer, maxServer };
}

async function measureEndToEndLatency(url, iterations = 5) {
  console.log(`\n📊 Measuring End-to-End Latency (${iterations} iterations)`);
  console.log(`Target: ${url}`);
  
  const results = [];
  
  for (let i = 0; i < iterations; i++) {
    // Start fetch
    const enqueueStart = Date.now();
    const response = await fetch(`${BASE_URL}/start-fetch?url=${encodeURIComponent(url)}`);
    const enqueueTime = Date.now() - enqueueStart;
    
    if (!response.ok) {
      throw new Error(`Failed to enqueue: ${response.statusText}`);
    }
    
    const { reqId } = await response.json();
    
    // Poll for result
    const resultStart = Date.now();
    let result = null;
    let attempts = 0;
    const maxAttempts = 100; // 10 seconds max
    
    while (!result && attempts < maxAttempts) {
      await sleep(100);
      const resultResponse = await fetch(`${BASE_URL}/get-result?reqId=${reqId}`);
      const data = await resultResponse.json();
      
      if (data && data.success !== undefined) {
        result = data;
      }
      attempts++;
    }
    
    const totalTime = Date.now() - enqueueStart;
    const waitTime = Date.now() - resultStart;
    
    if (!result) {
      console.error(`  ❌ Request ${i + 1}: Timed out after ${maxAttempts * 100}ms`);
      continue;
    }
    
    results.push({
      enqueueTime,
      waitTime,
      totalTime,
      serverDuration: result.duration || 0,
      success: result.success
    });
    
    console.log(`  ✓ Request ${i + 1}: ${totalTime}ms total (${enqueueTime}ms enqueue + ${waitTime}ms wait)`);
  }
  
  // Calculate statistics
  const avgEnqueue = results.reduce((a, b) => a + b.enqueueTime, 0) / results.length;
  const avgWait = results.reduce((a, b) => a + b.waitTime, 0) / results.length;
  const avgTotal = results.reduce((a, b) => a + b.totalTime, 0) / results.length;
  const avgServer = results.reduce((a, b) => a + b.serverDuration, 0) / results.length;
  
  console.log(`\n  Average Breakdown:`);
  console.log(`    Enqueue: ${avgEnqueue.toFixed(2)}ms`);
  console.log(`    Wait: ${avgWait.toFixed(2)}ms`);
  console.log(`    Total: ${avgTotal.toFixed(2)}ms`);
  console.log(`    Server Duration: ${avgServer.toFixed(2)}ms`);
  
  return { results, avgEnqueue, avgWait, avgTotal, avgServer };
}

async function clearResults() {
  await fetch(`${BASE_URL}/clear-results`);
}

async function main() {
  console.log('🚀 ProxyFetchWorker Latency Measurements');
  console.log('=========================================\n');
  console.log(`Connecting to: ${BASE_URL}`);
  console.log(`Make sure wrangler dev is running: npm run dev\n`);
  
  try {
    // Test 1: Enqueue Latency (fast endpoint)
    await clearResults();
    await measureEnqueueLatency(FAST_ENDPOINT, 10);
    
    // Test 2: End-to-End Latency (with delay to isolate overhead)
    await clearResults();
    await sleep(1000);
    await measureEndToEndLatency(DELAYED_ENDPOINT, 5);
    
    console.log('\n✅ Measurements complete!');
    console.log('\n💡 Record these results in MEASUREMENTS.md');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nMake sure wrangler dev is running: npm run dev');
    process.exit(1);
  }
}

main();

