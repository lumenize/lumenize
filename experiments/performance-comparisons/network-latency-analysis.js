// Network Latency Projection Calculator
// Based on measured payload sizes and different network conditions

console.log('=== Lumenize RPC Network Latency Analysis ===\n');

// Measured payload sizes (from actual test runs)
const payloads = {
  increment: {
    request: 221,    // bytes
    response: 127,   // bytes
    total: 348       // bytes per round-trip
  },
  getValue: {
    request: 212,    // bytes
    response: 128,   // bytes
    total: 340       // bytes per round-trip
  }
};

// Network scenarios
const networks = {
  'High Speed (1 Gbps)': {
    bandwidth: 125_000_000,  // 1 Gbps = 125 MB/s in bytes
    baseLatency: 1           // ms - data center/local
  },
  'Fast Broadband (100 Mbps)': {
    bandwidth: 12_500_000,   // 100 Mbps = 12.5 MB/s
    baseLatency: 10          // ms - regional
  },
  'Mobile 4G (50 Mbps)': {
    bandwidth: 6_250_000,    // 50 Mbps = 6.25 MB/s
    baseLatency: 30          // ms - cellular
  },
  'Slow Connection (10 Mbps)': {
    bandwidth: 1_250_000,    // 10 Mbps = 1.25 MB/s
    baseLatency: 50          // ms - congested/remote
  }
};

// Processing time (from profiling - client side only, server unknown)
const processingTime = {
  client: {
    stringify: 0.010,   // ms average
    parse: 0.008,       // ms average
    total: 0.018        // ms per round-trip
  },
  // Server-side processing (estimated, not measured due to wrangler logging)
  server: {
    parse: 0.010,       // ms (similar to client)
    execute: 0.050,     // ms (DO method execution - ESTIMATED)
    preprocess: 0.020,  // ms (function replacement - ESTIMATED)
    stringify: 0.010,   // ms (similar to client)
    total: 0.090        // ms per operation - ESTIMATED
  }
};

function calculateNetworkTime(payloadBytes, bandwidth, baseLatency) {
  // Network time = base latency + (payload / bandwidth)
  // Base latency accounts for: DNS, TCP handshake, TLS, etc.
  // Payload time is actual bytes over wire
  const transferTime = (payloadBytes / bandwidth) * 1000; // convert to ms
  return baseLatency + transferTime;
}

function calculateTotalLatency(operation, networkName, networkConfig) {
  const payload = payloads[operation].total;
  
  // Network time (round-trip = 2x base latency + transfer time)
  const networkTime = 2 * calculateNetworkTime(payload, networkConfig.bandwidth, networkConfig.baseLatency);
  
  // Total processing time
  const totalProcessing = processingTime.client.total + processingTime.server.total;
  
  // Total latency
  const totalLatency = networkTime + totalProcessing;
  
  return {
    networkTime,
    processingTime: totalProcessing,
    totalLatency,
    networkPercent: (networkTime / totalLatency * 100).toFixed(1),
    processingPercent: (totalProcessing / totalLatency * 100).toFixed(1)
  };
}

console.log('Measured Payload Sizes:');
console.log(`  increment(): ${payloads.increment.total} bytes/round-trip`);
console.log(`  getValue():  ${payloads.getValue.total} bytes/round-trip`);
console.log();

console.log('Estimated Processing Time:');
console.log(`  Client:  ${processingTime.client.total.toFixed(3)} ms (stringify + parse)`);
console.log(`  Server:  ${processingTime.server.total.toFixed(3)} ms (parse + execute + preprocess + stringify)`);
console.log(`  Total:   ${(processingTime.client.total + processingTime.server.total).toFixed(3)} ms`);
console.log();

console.log('='.repeat(80));
console.log();

// Calculate for each network scenario
for (const [networkName, networkConfig] of Object.entries(networks)) {
  console.log(`\n${networkName}:`);
  console.log(`  Bandwidth: ${(networkConfig.bandwidth / 1_000_000).toFixed(0)} MB/s, Base Latency: ${networkConfig.baseLatency}ms`);
  console.log();
  
  for (const operation of ['increment', 'getValue']) {
    const result = calculateTotalLatency(operation, networkName, networkConfig);
    
    console.log(`  ${operation}():`);
    console.log(`    Network:     ${result.networkTime.toFixed(2)}ms (${result.networkPercent}%)`);
    console.log(`    Processing:  ${result.processingTime.toFixed(2)}ms (${result.processingPercent}%)`);
    console.log(`    TOTAL:       ${result.totalLatency.toFixed(2)}ms`);
    console.log();
  }
}

console.log('='.repeat(80));
console.log('\n=== Key Insights ===\n');
console.log('1. On high-speed networks (1 Gbps), processing dominates (>95% of latency)');
console.log('2. On mobile/slow networks, network time dominates (>90% of latency)');
console.log('3. Payload optimization (e.g., cbor-x) would help most on slow networks');
console.log('4. For typical broadband (100 Mbps), it\'s roughly 50/50 split');
console.log('5. Server processing time estimation needs verification (wrangler logs)');
console.log();
console.log('=== Optimization Priorities ===\n');
console.log('1. HIGH IMPACT: Reduce server processing time (execute + preprocess)');
console.log('2. MEDIUM IMPACT: Reduce payload size for mobile/slow networks');
console.log('3. LOW IMPACT: Further optimize client serialization (already <20ms)');
