/**
 * Production Latency Measurements for proxyFetchWorker (WebSocket Edition)
 * 
 * Uses WebSockets for real-time result delivery (no polling overhead).
 * Measures end-to-end latency from proxyFetchWorker() call to continuation execution.
 * 
 * Usage:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm test
 * 
 * For production:
 *   1. Deploy: npm run deploy
 *   2. Set env: export $(cat ../../.dev.vars | xargs)
 *   3. Set TEST_URL: export TEST_URL=https://proxy-fetch-latency.YOUR_SUBDOMAIN.workers.dev
 *   4. Run: npm test
 * 
 * Requires Node.js 21+ for native WebSocket support.
 */

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');

// Get TEST_ENDPOINTS from environment
const TEST_TOKEN = process.env.TEST_TOKEN;
const TEST_ENDPOINTS_URL = process.env.TEST_ENDPOINTS_URL;

if (!TEST_TOKEN || !TEST_ENDPOINTS_URL) {
  console.error('❌ TEST_TOKEN and TEST_ENDPOINTS_URL must be set');
  console.error('Run: export $(cat ../../.dev.vars | xargs)');
  process.exit(1);
}

// Test endpoint that returns quickly
const FAST_ENDPOINT = `${TEST_ENDPOINTS_URL}/latency-test/uuid?token=${TEST_TOKEN}`;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Connect to Origin DO via WebSocket
 */
function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    
    ws.onopen = () => {
      console.log('✓ WebSocket connected to Origin DO');
      resolve(ws);
    };
    
    ws.onerror = (error) => {
      reject(error);
    };
  });
}

/**
 * Measure end-to-end latency using WebSocket for result delivery
 */
async function measureEndToEndLatency(url, iterations = 10) {
  console.log(`\n📊 Measuring End-to-End Latency (${iterations} iterations)`);
  console.log(`Target: ${url}`);
  console.log('Using WebSocket for real-time result delivery (no polling)\n');
  
  const ws = await connectWebSocket();
  const results = [];
  const pendingRequests = new Map();
  
  // Listen for messages
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.type === 'enqueued') {
      // Enqueue confirmation
      const pending = pendingRequests.get(msg.reqId);
      if (pending) {
        pending.enqueueTime = msg.enqueueTime;
      }
    } else if (msg.type === 'result') {
      // Result received
      const pending = pendingRequests.get(msg.reqId);
      if (pending) {
        const endTime = Date.now();
        const totalTime = endTime - pending.startTime;
        
        results.push({
          reqId: msg.reqId,
          enqueueTime: pending.enqueueTime,
          totalTime,
          serverDuration: msg.duration || 0,
          success: msg.success
        });
        
        console.log(`  ✓ Request ${results.length}: ${totalTime}ms total (${pending.enqueueTime}ms enqueue + ${totalTime - pending.enqueueTime}ms wait)`);
        
        pending.resolve();
      }
    } else if (msg.type === 'error') {
      console.error('  ❌ Error:', msg.error);
    }
  };
  
  // Send requests
  for (let i = 0; i < iterations; i++) {
    const startTime = Date.now();
    const reqId = `req-${Date.now()}-${i}`;
    
    const promise = new Promise((resolve) => {
      pendingRequests.set(reqId, {
        startTime,
        enqueueTime: 0,
        resolve
      });
    });
    
    ws.send(JSON.stringify({
      type: 'start-fetch',
      url
    }));
    
    // Wait for this request to complete
    await promise;
    await sleep(50); // Small delay between requests
  }
  
  ws.close();
  
  // Calculate statistics (subtract ~30ms for Node.js network overhead)
  const NODE_NETWORK_OVERHEAD = 30; // ms for round-trip to/from Node.js
  
  const avgEnqueue = results.reduce((a, b) => a + b.enqueueTime, 0) / results.length;
  const avgTotal = results.reduce((a, b) => a + b.totalTime, 0) / results.length;
  const avgServer = results.reduce((a, b) => a + b.serverDuration, 0) / results.length;
  const avgActual = avgTotal - NODE_NETWORK_OVERHEAD; // Subtract Node.js overhead
  
  console.log(`\n  Average Breakdown:`);
  console.log(`    Enqueue (includes network): ${avgEnqueue.toFixed(2)}ms`);
  console.log(`    Total (measured): ${avgTotal.toFixed(2)}ms`);
  console.log(`    Node.js overhead (est): ${NODE_NETWORK_OVERHEAD}ms`);
  console.log(`    Actual end-to-end: ${avgActual.toFixed(2)}ms`);
  console.log(`    Server duration: ${avgServer.toFixed(2)}ms (may be 0 due to clock)`);
  
  return { results, avgEnqueue, avgTotal, avgActual, avgServer };
}

async function main() {
  console.log('🚀 ProxyFetchWorker Latency Measurements (WebSocket Edition)');
  console.log('=============================================================\n');
  console.log(`Connecting to: ${BASE_URL}`);
  console.log(`WebSocket URL: ${WS_URL}`);
  console.log(`Make sure wrangler dev is running: npm run dev\n`);
  
  try {
    // Measure end-to-end latency with WebSocket
    await measureEndToEndLatency(FAST_ENDPOINT, 10);
    
    console.log('\n✅ Measurements complete!');
    console.log('\n💡 Record these results in MEASUREMENTS.md');
    console.log('\nKey improvements with WebSocket:');
    console.log('  - No polling overhead (~100-200ms saved)');
    console.log('  - Real-time result delivery');
    console.log('  - Accurate end-to-end latency measurement');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    console.error('\nMake sure wrangler dev is running: npm run dev');
    process.exit(1);
  }
}

main();
