/**
 * Proxy-Fetch Performance Measurements
 * 
 * Compares Direct vs Current (proxyFetch) vs Simple (proxyFetchSimple)
 * Measures both latency (DO timing) and billing (R2 logs)
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
const WITH_BILLING = process.env.WITH_BILLING === 'true' || process.argv.includes('--billing');

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
  console.log(`Billing analysis: ${WITH_BILLING ? 'ENABLED (R2 logs)' : 'DISABLED (latency only)'}`);
  console.log('');
  console.log('Comparing:');
  console.log('  • Direct - Origin DO fetches directly (baseline)');
  console.log('  • Current - proxyFetch with Orchestrator DO');
  console.log('  • Simple - proxyFetchSimple without Orchestrator');
  console.log('');
  
  try {
    const results = await runAllExperiments(BASE_URL, OPS_COUNT, { 
      withBilling: WITH_BILLING,
      scriptName: WITH_BILLING ? 'proxy-fetch-performance' : undefined
    });
    
    // Additional analysis
    if (results.length === 3) {
      const [direct, current, simple] = results;
      
      console.log('\n\n💡 ANALYSIS');
      console.log('===========\n');
      
      // Latency comparison
      const directAvg = parseFloat(direct.avgPerOp);
      const currentAvg = parseFloat(current.avgPerOp);
      const simpleAvg = parseFloat(simple.avgPerOp);
      
      const currentOverhead = currentAvg - directAvg;
      const simpleOverhead = simpleAvg - directAvg;
      
      console.log('Latency Overhead (vs Direct):');
      console.log(`  Current: +${currentOverhead.toFixed(2)}ms (+${((currentOverhead / directAvg) * 100).toFixed(1)}%)`);
      console.log(`  Simple: +${simpleOverhead.toFixed(2)}ms (+${((simpleOverhead / directAvg) * 100).toFixed(1)}%)`);
      
      if (WITH_BILLING && direct.billing && current.billing && simple.billing) {
        console.log('\nBilling Cost Comparison:');
        console.log(`  Direct: ${direct.billing.avgWallTimeMs}ms wall time`);
        console.log(`  Current: ${current.billing.avgWallTimeMs}ms wall time`);
        console.log(`  Simple: ${simple.billing.avgWallTimeMs}ms wall time`);
        
        const directCost = parseFloat(direct.billing.avgWallTimeMs);
        const currentCost = parseFloat(current.billing.avgWallTimeMs);
        const simpleCost = parseFloat(simple.billing.avgWallTimeMs);
        
        const currentSavings = ((directCost - currentCost) / directCost) * 100;
        const simpleSavings = ((directCost - simpleCost) / directCost) * 100;
        
        console.log(`\n  Current savings: ${currentSavings.toFixed(1)}% vs Direct`);
        console.log(`  Simple savings: ${simpleSavings.toFixed(1)}% vs Direct`);
        
        if (simpleCost < currentCost) {
          const improvement = ((currentCost - simpleCost) / currentCost) * 100;
          console.log(`  Simple is ${improvement.toFixed(1)}% cheaper than Current`);
        }
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

