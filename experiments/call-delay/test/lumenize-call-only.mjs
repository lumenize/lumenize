import { runBatch, displayResults } from '@lumenize/for-experiments/node-client';

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787';
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://');
const OPS_COUNT = parseInt(process.argv[2] || '25', 10);

async function runTest() {
  console.log('\n🧪 @lumenize/call Only Test');
  console.log('========================\n');
  console.log(`Target: ${WS_URL}`);
  console.log(`Operations: ${OPS_COUNT}\n`);
  
  try {
    const results = await runBatch(WS_URL, 'lumenize-call', OPS_COUNT, 30000);
    
    console.log('\n📈 RESULTS\n');
    displayResults(results);
    
    if (results.errors > 0) {
      console.log('\n⚠️  @lumenize/call had errors!');
    } else {
      console.log('\n✅ @lumenize/call completed successfully!');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

runTest();
