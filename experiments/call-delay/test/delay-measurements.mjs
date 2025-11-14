/**
 * Call Delay Measurements
 * 
 * Compares @lumenize/call vs Workers RPC performance using batch-based testing
 * 
 * Usage:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm test [ops_count]
 */

import { runBatch, displayResults } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');

// Get ops count from command line or env var (default: 10)
const OPS_COUNT = parseInt(process.argv[2] || process.env.OPS_COUNT || '10', 10);

async function runExperiment() {
  console.log('\n🧪 Call Delay Experiment');
  console.log('========================\n');
  console.log(`Target: ${WS_URL}`);
  console.log(`Operations per test: ${OPS_COUNT}`);
  console.log(`\nPrimary question: How much slower is @lumenize/call vs Workers RPC?`);
  console.log(`Secondary: Does Workers RPC hit the 6 concurrent request limit?\n`);
  
  try {
    // Warmup
    console.log('🔥 Warming up...');
    await runBatch(WS_URL, 'lumenize-call', 10);
    
    // Wait between tests
    await sleep(2000);
    
    // Measure @lumenize/call
    console.log(`\n📊 Measuring @lumenize/call mode (${OPS_COUNT} operations)`);
    const lumenizeResults = await runBatch(WS_URL, 'lumenize-call', OPS_COUNT);
    
    // Wait between tests
    await sleep(2000);
    
    // Measure Workers RPC
    console.log(`\n📊 Measuring workers-rpc mode (${OPS_COUNT} operations)`);
    const rpcResults = await runBatch(WS_URL, 'workers-rpc', OPS_COUNT);
    
    // Display results
    console.log('\n\n📈 RESULTS');
    console.log('==========\n');
    
    console.log('@lumenize/call (fire-and-forget):');
    displayResults(lumenizeResults);
    
    console.log('\nWorkers RPC (awaited):');
    displayResults(rpcResults);
    
    // Calculate difference
    const diff = (parseFloat(lumenizeResults.avgPerOp) - parseFloat(rpcResults.avgPerOp)).toFixed(2);
    const pct = (((parseFloat(lumenizeResults.avgPerOp) / parseFloat(rpcResults.avgPerOp)) - 1) * 100).toFixed(1);
    
    console.log(`\n📊 Performance:`);
    console.log(`   @lumenize/call is ${diff}ms slower per operation (${pct > 0 ? '+' : ''}${pct}%)`);
    
    if (rpcResults.errors > 0 || rpcResults.completed < OPS_COUNT) {
      console.log(`\n⚠️  Workers RPC hit concurrency limits!`);
      console.log(`   Only ${rpcResults.completed}/${OPS_COUNT} completed`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Experiment failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

runExperiment();
