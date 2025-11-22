/**
 * Proxy-Fetch Performance Measurements
 * 
 * Compares Direct vs ProxyFetch (two-hop architecture)
 * Measures both latency (client-side timing) and billing (R2 logs)
 * 
 * Usage:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm test [ops_count]
 * 
 * Production:
 *   npm run deploy
 *   TEST_URL=https://proxy-fetch-performance.YOUR_ACCOUNT.workers.dev npm test 50
 */

import { runAllExperiments } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const OPS_COUNT = parseInt(process.argv[2] || process.env.OPS_COUNT || '50', 10);
const TAIL_LOG_FILE = process.env.TAIL_LOG_FILE || 'tail-logs.jsonl';
const WITH_BILLING = process.env.WITH_BILLING === 'true' || process.argv.includes('--billing');
const ENDPOINT_PATH = process.env.ENDPOINT_PATH || '/uuid';

async function runExperiment() {
  console.log('\n🧪 Proxy-Fetch Performance Experiment');
  console.log('=====================================\n');
  console.log(`Target: ${BASE_URL}`);
  
  // Health check - fail fast if server is down
  try {
    console.log('🔍 Checking server health...');
    const versionResponse = await fetch(`${BASE_URL}/version`, { 
      signal: AbortSignal.timeout(3000) // 3 second timeout
    });
    if (!versionResponse.ok) {
      throw new Error(`Server health check failed: ${versionResponse.status}`);
    }
    const versionData = await versionResponse.json();
    console.log(`✅ Server is up (version ${versionData.version})\n`);
  } catch (error) {
    console.error('\n❌ Server is not responding!');
    console.error('   Make sure to run `npm run dev` in another terminal first.');
    console.error(`   Error: ${error.message}\n`);
    process.exit(1);
  }
  
  console.log(`Operations per variation: ${OPS_COUNT}`);
  console.log(`Test endpoint: ${ENDPOINT_PATH}`);
  console.log(`Billing analysis: ${WITH_BILLING ? `ENABLED (wrangler tail logs: ${TAIL_LOG_FILE})` : 'DISABLED (latency only)'}`);
  console.log('');
  console.log('Comparing:');
  console.log('  • Direct - Origin DO fetches directly (baseline)');
  console.log('  • ProxyFetch - Two-hop proxy (Origin DO → Worker → External API)');
  console.log('');
  
  try {
    // Set endpoint path in environment (will be passed to Worker/DO via wrangler)
    // Note: For production, set ENDPOINT_PATH secret: wrangler secret put ENDPOINT_PATH
    if (ENDPOINT_PATH !== '/uuid') {
      console.log(`⚠️  Note: Using custom endpoint ${ENDPOINT_PATH}`);
      console.log(`   For production, set: wrangler secret put ENDPOINT_PATH\n`);
    }
    
    const results = await runAllExperiments(BASE_URL, OPS_COUNT, { 
      withBilling: WITH_BILLING,
      scriptName: WITH_BILLING ? 'proxy-fetch-performance' : undefined,
      tailLogPath: WITH_BILLING ? TAIL_LOG_FILE : undefined
    });
    
    // Additional analysis
    if (results.length === 2) {
      const [direct, proxyfetch] = results;
      
      console.log('\n\n💡 ANALYSIS');
      console.log('===========\n');
      
      // Latency comparison
      const directAvg = parseFloat(direct.avgPerOp);
      const proxyfetchAvg = parseFloat(proxyfetch.avgPerOp);
      
      const overhead = proxyfetchAvg - directAvg;
      
      console.log('Latency Overhead (vs Direct):');
      console.log(`  ProxyFetch: +${overhead.toFixed(2)}ms (+${((overhead / directAvg) * 100).toFixed(1)}%)`);
      
      if (WITH_BILLING && direct.billing && proxyfetch.billing) {
        console.log('\nBilling Cost Comparison:');
        console.log(`  Direct: ${direct.billing.avgWallTimeMs}ms wall time`);
        console.log(`  ProxyFetch: ${proxyfetch.billing.avgWallTimeMs}ms wall time`);
        
        const directCost = parseFloat(direct.billing.avgWallTimeMs);
        const proxyfetchCost = parseFloat(proxyfetch.billing.avgWallTimeMs);
        
        const savings = ((directCost - proxyfetchCost) / directCost) * 100;
        const absolute = directCost - proxyfetchCost;
        
        console.log(`\n  Cost savings: ${savings.toFixed(1)}% (${absolute.toFixed(2)}ms less wall time)`);
        console.log(`  Expected monthly savings: ~${((savings * 0.012) / 1000).toFixed(3)}¢ per 1000 requests`);
      }
      
      console.log('\n✅ Experiment complete!\n');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Experiment failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

runExperiment();

