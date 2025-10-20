#!/usr/bin/env node

/**
 * Analyzes performance test results and generates side-by-side comparison
 * 
 * Reads the most recent Cap'n Web and Lumenize test results from the results/ directory
 * and displays a comprehensive comparison table.
 */

const fs = require('fs');
const path = require('path');

// ANSI color codes
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
};

/**
 * Parse test output to extract performance metrics
 */
function parseTestResults(content) {
  const runs = [];
  
  // Extract all performance measurement blocks
  // Format: "Lumenize RPC - 100 increments:\n  Total: 38.93ms\n  Average: 0.389ms per operation"
  // Also handle: "Lumenize RPC - 50 mixed operations (increment + getValue):\n  Total: 44.01ms (100 operations)"
  const measurementRegex = /(Lumenize RPC|Cap'n Web) - (\d+) (.+?):\s+Total: ([\d.]+)ms(?: \((\d+) operations\))?\s+Average: ([\d.]+)ms per operation/g;
  let match;
  
  while ((match = measurementRegex.exec(content)) !== null) {
    const [, framework, iterationCount, testDescription, totalTime, totalOps, avgTime] = match;
    
    // For mixed operations, use the total ops count, otherwise use iteration count
    const operations = totalOps ? parseInt(totalOps, 10) : parseInt(iterationCount, 10);
    
    runs.push({
      testName: testDescription.trim(),
      operations,
      totalTime: parseFloat(totalTime),
      avgTime: parseFloat(avgTime),
      framework,
    });
  }
  
  return runs;
}

/**
 * Group runs by test name and calculate statistics
 */
function groupAndAnalyze(runs) {
  const grouped = {};
  
  runs.forEach(run => {
    if (!grouped[run.testName]) {
      grouped[run.testName] = [];
    }
    grouped[run.testName].push(run);
  });
  
  const stats = {};
  
  for (const [testName, testRuns] of Object.entries(grouped)) {
    const avgTimes = testRuns.map(r => r.avgTime);
    const totalTimes = testRuns.map(r => r.totalTime);
    
    avgTimes.sort((a, b) => a - b);
    totalTimes.sort((a, b) => a - b);
    
    const median = arr => {
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
    };
    
    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    
    stats[testName] = {
      operations: testRuns[0].operations,
      avgTime: {
        median: median(avgTimes),
        mean: mean(avgTimes),
        min: avgTimes[0],
        max: avgTimes[avgTimes.length - 1],
        values: avgTimes,
      },
      totalTime: {
        median: median(totalTimes),
        mean: mean(totalTimes),
        min: totalTimes[0],
        max: totalTimes[totalTimes.length - 1],
        values: totalTimes,
      },
      runs: testRuns.length,
    };
  }
  
  return stats;
}

/**
 * Find the most recent result files
 */
function findLatestResults() {
  const resultsDir = path.join(__dirname, 'results');
  
  if (!fs.existsSync(resultsDir)) {
    console.error(`${COLORS.red}Error: results/ directory not found. Run ./run-comparison.sh first.${COLORS.reset}`);
    process.exit(1);
  }
  
  const files = fs.readdirSync(resultsDir);
  
  const capnwebFiles = files.filter(f => f.startsWith('capnweb_')).sort().reverse();
  const lumenizeFiles = files.filter(f => f.startsWith('lumenize_')).sort().reverse();
  
  if (capnwebFiles.length === 0 || lumenizeFiles.length === 0) {
    console.error(`${COLORS.red}Error: No test results found. Run ./run-comparison.sh first.${COLORS.reset}`);
    process.exit(1);
  }
  
  return {
    capnweb: path.join(resultsDir, capnwebFiles[0]),
    lumenize: path.join(resultsDir, lumenizeFiles[0]),
  };
}

/**
 * Display side-by-side comparison table
 */
function displayComparison(capnwebStats, lumenizeStats) {
  console.log(`\n${COLORS.bright}============================================================${COLORS.reset}`);
  console.log(`${COLORS.bright}Performance Comparison: Cap'n Web vs Lumenize RPC${COLORS.reset}`);
  console.log(`${COLORS.bright}============================================================${COLORS.reset}\n`);
  
  // Get all test names
  const allTests = new Set([...Object.keys(capnwebStats), ...Object.keys(lumenizeStats)]);
  
  for (const testName of allTests) {
    const cw = capnwebStats[testName];
    const lz = lumenizeStats[testName];
    
    if (!cw || !lz) {
      console.log(`${COLORS.yellow}⚠ Test "${testName}" missing from one framework - skipping${COLORS.reset}\n`);
      continue;
    }
    
    console.log(`${COLORS.cyan}${COLORS.bright}${testName}${COLORS.reset} (${cw.operations} operations)`);
    console.log(`${COLORS.blue}${'─'.repeat(60)}${COLORS.reset}`);
    
    // Calculate comparison
    const cwMedian = cw.avgTime.median;
    const lzMedian = lz.avgTime.median;
    const diff = ((lzMedian - cwMedian) / cwMedian * 100);
    const winner = diff < 0 ? 'Lumenize' : diff > 0 ? 'Cap\'n Web' : 'Tie';
    const diffColor = Math.abs(diff) < 5 ? COLORS.green : Math.abs(diff) < 20 ? COLORS.yellow : COLORS.red;
    
    // Avg time per operation
    console.log(`\n${COLORS.bright}Average Time per Operation (ms):${COLORS.reset}`);
    console.log(`  Cap'n Web:     ${cwMedian.toFixed(3)}ms  (range: ${cw.avgTime.min.toFixed(3)} - ${cw.avgTime.max.toFixed(3)})`);
    console.log(`  Lumenize:      ${lzMedian.toFixed(3)}ms  (range: ${lz.avgTime.min.toFixed(3)} - ${lz.avgTime.max.toFixed(3)})`);
    console.log(`  Difference:    ${diffColor}${diff > 0 ? '+' : ''}${diff.toFixed(1)}%${COLORS.reset} (${winner} wins)`);
    
    // Total time
    console.log(`\n${COLORS.bright}Total Time (ms):${COLORS.reset}`);
    console.log(`  Cap'n Web:     ${cw.totalTime.median.toFixed(2)}ms  (range: ${cw.totalTime.min.toFixed(2)} - ${cw.totalTime.max.toFixed(2)})`);
    console.log(`  Lumenize:      ${lz.totalTime.median.toFixed(2)}ms  (range: ${lz.totalTime.min.toFixed(2)} - ${lz.totalTime.max.toFixed(2)})`);
    
    // Throughput
    const cwThroughput = 1000 / cwMedian;
    const lzThroughput = 1000 / lzMedian;
    console.log(`\n${COLORS.bright}Throughput (ops/sec):${COLORS.reset}`);
    console.log(`  Cap'n Web:     ${cwThroughput.toFixed(0)} ops/sec`);
    console.log(`  Lumenize:      ${lzThroughput.toFixed(0)} ops/sec`);
    
    // Variance analysis
    const cwVariance = ((cw.avgTime.max - cw.avgTime.min) / cw.avgTime.median * 100);
    const lzVariance = ((lz.avgTime.max - lz.avgTime.min) / lz.avgTime.median * 100);
    console.log(`\n${COLORS.bright}Measurement Variance:${COLORS.reset}`);
    console.log(`  Cap'n Web:     ±${cwVariance.toFixed(1)}%`);
    console.log(`  Lumenize:      ±${lzVariance.toFixed(1)}%`);
    
    console.log('');
  }
  
  // Summary
  console.log(`${COLORS.bright}${'='.repeat(60)}${COLORS.reset}`);
  console.log(`${COLORS.bright}Summary${COLORS.reset}\n`);
  
  let cwWins = 0;
  let lzWins = 0;
  let ties = 0;
  
  for (const testName of allTests) {
    const cw = capnwebStats[testName];
    const lz = lumenizeStats[testName];
    if (!cw || !lz) continue;
    
    const diff = ((lz.avgTime.median - cw.avgTime.median) / cw.avgTime.median * 100);
    if (Math.abs(diff) < 5) ties++;
    else if (diff < 0) lzWins++;
    else cwWins++;
  }
  
  console.log(`Tests run: ${allTests.size}`);
  console.log(`${COLORS.green}Cap'n Web wins:    ${cwWins}${COLORS.reset}`);
  console.log(`${COLORS.blue}Lumenize wins:     ${lzWins}${COLORS.reset}`);
  console.log(`${COLORS.yellow}Ties (<5% diff):   ${ties}${COLORS.reset}`);
  
  if (ties === allTests.size) {
    console.log(`\n${COLORS.green}${COLORS.bright}🎉 Performance is effectively identical!${COLORS.reset}`);
    console.log(`${COLORS.green}Choose based on developer experience preferences.${COLORS.reset}`);
  } else if (Math.abs(cwWins - lzWins) <= 1 && ties >= allTests.size / 2) {
    console.log(`\n${COLORS.green}${COLORS.bright}✅ Performance is very similar (most tests within 5%)${COLORS.reset}`);
    console.log(`${COLORS.green}Both frameworks are competitive.${COLORS.reset}`);
  }
  
  console.log('');
}

// Main execution
function main() {
  const files = findLatestResults();
  
  console.log(`${COLORS.cyan}Reading results:${COLORS.reset}`);
  console.log(`  Cap'n Web: ${path.basename(files.capnweb)}`);
  console.log(`  Lumenize:  ${path.basename(files.lumenize)}`);
  
  const capnwebContent = fs.readFileSync(files.capnweb, 'utf8');
  const lumenizeContent = fs.readFileSync(files.lumenize, 'utf8');
  
  const capnwebRuns = parseTestResults(capnwebContent);
  const lumenizeRuns = parseTestResults(lumenizeContent);
  
  if (capnwebRuns.length === 0 || lumenizeRuns.length === 0) {
    console.error(`${COLORS.red}Error: Could not parse test results. Check the output format.${COLORS.reset}`);
    process.exit(1);
  }
  
  const capnwebStats = groupAndAnalyze(capnwebRuns);
  const lumenizeStats = groupAndAnalyze(lumenizeRuns);
  
  displayComparison(capnwebStats, lumenizeStats);
}

main();
