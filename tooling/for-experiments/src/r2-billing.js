/**
 * Billing Analysis for Experiments
 * 
 * Extracts wall clock billing metrics from logs.
 * 
 * TWO MODES:
 * 1. Wrangler Tail (RECOMMENDED): Parse logs captured via `wrangler tail --format json`
 * 2. Mock Mode: Generate realistic mock data for local testing
 * 
 * R2 Logpush support removed - proved unreliable in practice
 */

import { readFileSync } from 'fs';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';

// R2 configuration - all loaded from environment
const R2_CONFIG = {
  get bucketName() {
    return process.env.CLOUDFLARE_R2_BUCKET_NAME || 'cloudflare-managed-03e4752d';
  },
  get accountId() {
    return process.env.CLOUDFLARE_ACCOUNT_ID || '6c2517e636c90da5abf4e8d2a8eab42f';
  },
  get endpoint() {
    return `https://${this.accountId}.r2.cloudflarestorage.com`;
  }
};

/**
 * Create S3 client for R2 access
 * 
 * @returns {S3Client}
 */
function createR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: R2_CONFIG.endpoint,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * Poll R2 every 10s until logs appear (with max timeout)
 * 
 * @param {string} scriptName - Script name to filter logs
 * @param {Date} searchStartTime - Start of time window
 * @param {Date} searchEndTime - End of time window
 * @param {number} expectedCount - Expected number of log entries
 * @param {Object} options - { maxWaitMs: 600000, pollIntervalMs: 10000, mockMode: false }
 * @returns {Promise<Array>} Array of log entries
 */
export async function pollForR2Logs(scriptName, searchStartTime, searchEndTime, expectedCount, options = {}) {
  const maxWaitMs = options.maxWaitMs || 600000; // 10 minutes
  const pollIntervalMs = options.pollIntervalMs || 10000; // 10 seconds
  const mockMode = options.mockMode !== undefined ? options.mockMode : false;
  
  console.log(`\n⏳ Polling R2 for logs...`);
  console.log(`   Script: ${scriptName}`);
  console.log(`   Window: ${searchStartTime.toISOString()} - ${searchEndTime.toISOString()}`);
  console.log(`   Expecting: ${expectedCount} log entries`);
  
  // Mock mode for local testing
  if (mockMode) {
    console.log(`   🔧 MOCK MODE: Returning simulated billing data\n`);
    return generateMockLogs(scriptName, expectedCount, searchStartTime);
  }
  
  // Real R2 polling
  const client = createR2Client();
  const startTime = Date.now();
  let attempt = 0;
  
  // Determine date prefixes to search (may span multiple days)
  const datePrefixes = [];
  const currentDate = new Date(searchStartTime);
  while (currentDate <= searchEndTime) {
    const dateStr = currentDate.toISOString().split('T')[0]; // YYYY-MM-DD
    datePrefixes.push(dateStr);
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  console.log(`   📅 Searching date prefixes: ${datePrefixes.join(', ')}`);
  
  while (true) {
    attempt++;
    const elapsed = Date.now() - startTime;
    
    console.log(`   🔍 Poll attempt ${attempt} (${(elapsed / 1000).toFixed(1)}s elapsed)...`);
    
    // List and download all log files for the date range
    const allLogs = [];
    for (const datePrefix of datePrefixes) {
      const logFiles = await listLogFiles(client, datePrefix);
      console.log(`      Found ${logFiles.length} log files for ${datePrefix}`);
      
      for (const fileKey of logFiles) {
        try {
          const logs = await downloadAndParseLogFile(client, fileKey);
          allLogs.push(...logs);
        } catch (error) {
          console.warn(`      ⚠️  Failed to download ${fileKey}: ${error.message}`);
        }
      }
    }
    
    // Filter by time window and script name
    const matchingLogs = filterLogsByTimeWindow(allLogs, scriptName, searchStartTime, searchEndTime);
    
    console.log(`      Matching logs: ${matchingLogs.length}/${expectedCount}`);
    
    // Check if we have enough logs
    if (matchingLogs.length >= expectedCount) {
      console.log(`   ✅ Found ${matchingLogs.length} logs (expected ${expectedCount})\n`);
      return matchingLogs.slice(0, expectedCount);
    }
    
    // Check timeout
    if (elapsed + pollIntervalMs > maxWaitMs) {
      console.log(`   ⏱️  Max wait time reached (${maxWaitMs}ms)\n`);
      console.warn(`   ⚠️  Only found ${matchingLogs.length}/${expectedCount} logs`);
      return matchingLogs;
    }
    
    // Wait before next poll
    console.log(`      Waiting ${pollIntervalMs}ms before next poll...`);
    await sleep(pollIntervalMs);
  }
}

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch billing metrics from R2 logs
 * 
 * @param {string} scriptName - Script name to filter logs
 * @param {number} batchStartTime - Batch start timestamp (ms)
 * @param {number} batchEndTime - Batch end timestamp (ms)
 * @param {number} expectedCount - Expected number of operations
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Billing metrics
 */
export async function fetchBillingMetrics(scriptName, batchStartTime, batchEndTime, expectedCount, options = {}) {
  // Time window with buffer for clock skew
  const bufferBefore = options.bufferBeforeMs || 30000; // 30s before
  const bufferAfter = options.bufferAfterMs || 120000; // 2min after
  
  const searchStart = new Date(batchStartTime - bufferBefore);
  const searchEnd = new Date(batchEndTime + bufferAfter);
  
  // Poll for logs
  const logs = await pollForR2Logs(scriptName, searchStart, searchEnd, expectedCount, options);
  
  // Extract metrics
  return extractMetricsFromLogs(logs, expectedCount);
}

/**
 * Extract billing metrics from log entries
 * 
 * For ProxyFetch approach: Separates DO wall time (billed) from Worker CPU time (billed)
 * Workers bill on CPU time, not wall time, so we don't add Worker wall time to total.
 * 
 * @param {Array} logs - Array of log entries
 * @param {number} expectedCount - Expected number of logs
 * @param {string} approach - Approach name (for special handling)
 * @returns {Object} Aggregated metrics
 */
function extractMetricsFromLogs(logs, expectedCount, approach = null) {
  if (logs.length === 0) {
    console.warn(`⚠️  No logs found`);
    return {
      count: 0,
      totalWallTimeMs: 0,
      totalCPUTimeMs: 0,
      avgWallTimeMs: 0,
      avgCPUTimeMs: 0,
      logs: []
    };
  }
  
  // For ProxyFetch: Separate DO logs (wall time billed) from Worker logs (CPU time billed)
  if (approach && approach.includes('proxyfetch')) {
    const doLogs = logs.filter(log => log.ExecutionModel === 'durableObject');
    const workerLogs = logs.filter(log => log.ExecutionModel === 'stateless');
    
    const doWallTime = doLogs.reduce((sum, log) => sum + (log.WallTimeMs || 0), 0);
    const doCpuTime = doLogs.reduce((sum, log) => sum + (log.CPUTimeMs || 0), 0);
    const workerCpuTime = workerLogs.reduce((sum, log) => sum + (log.CPUTimeMs || 0), 0);
    const workerWallTime = workerLogs.reduce((sum, log) => sum + (log.WallTimeMs || 0), 0);
    
    // Total billing: DO wall time (what we pay for DO) + Worker CPU time (what we pay for Worker)
    const totalBillingWallTime = doWallTime; // Only DO wall time counts for billing
    const totalBillingCpuTime = doCpuTime + workerCpuTime; // Both DO and Worker CPU time
    
    const metrics = {
      count: logs.length,
      totalWallTimeMs: totalBillingWallTime, // Only DO wall time (billed)
      totalCPUTimeMs: totalBillingCpuTime, // DO + Worker CPU time (billed)
      avgWallTimeMs: (totalBillingWallTime / doLogs.length || 1).toFixed(2), // Avg per DO invocation
      avgCPUTimeMs: (totalBillingCpuTime / logs.length).toFixed(2), // Avg across all invocations
      breakdown: {
        doLogs: doLogs.length,
        workerLogs: workerLogs.length,
        doWallTimeMs: doWallTime,
        doCpuTimeMs: doCpuTime,
        workerCpuTimeMs: workerCpuTime,
        workerWallTimeMs: workerWallTime // For reference (not billed)
      },
      logs: logs // For debugging
    };
    
    // Validate count (more lenient for ProxyFetch since we have 2 logs per operation)
    if (logs.length < expectedCount * 0.8 || logs.length > expectedCount * 1.5) {
      console.warn(`⚠️  Log count mismatch: expected ~${expectedCount}, found ${logs.length}`);
    }
    
    return metrics;
  }
  
  // For Direct: Simple aggregation (all logs are DO wall time)
  const totalWallTime = logs.reduce((sum, log) => sum + (log.WallTimeMs || 0), 0);
  const totalCPUTime = logs.reduce((sum, log) => sum + (log.CPUTimeMs || 0), 0);
  
  const metrics = {
    count: logs.length,
    totalWallTimeMs: totalWallTime,
    totalCPUTimeMs: totalCPUTime,
    avgWallTimeMs: (totalWallTime / logs.length).toFixed(2),
    avgCPUTimeMs: (totalCPUTime / logs.length).toFixed(2),
    logs: logs // For debugging
  };
  
  // Validate count
  if (logs.length < expectedCount * 0.8 || logs.length > expectedCount * 1.5) {
    console.warn(`⚠️  Log count mismatch: expected ~${expectedCount}, found ${logs.length}`);
  }
  
  return metrics;
}

/**
 * Parse wrangler tail logs from a JSON file
 * 
 * Handles both JSONL format (one JSON per line) and pretty-printed JSON (multi-line objects).
 * 
 * @param {string} filepath - Path to tail log file
 * @param {string} scriptName - Script name to filter (optional)
 * @param {Date} startTime - Start of time window (optional)
 * @param {Date} endTime - End of time window (optional)
 * @returns {Array} Parsed log entries in normalized format
 */
export function parseWranglerTailLogs(filepath, scriptName = null, startTime = null, endTime = null) {
  console.log(`\n📄 Parsing wrangler tail logs from: ${filepath}`);
  
  const content = readFileSync(filepath, 'utf-8');
  
  // Parse pretty-printed JSON by finding complete objects
  // Wrangler tail --format json outputs objects separated by newlines but spans multiple lines
  const logs = [];
  let currentObj = '';
  let braceDepth = 0;
  
  for (const line of content.split('\n')) {
    // Track brace depth to identify complete JSON objects
    for (const char of line) {
      if (char === '{') braceDepth++;
      if (char === '}') braceDepth--;
    }
    
    currentObj += line;
    
    // Complete object when braces balance
    if (braceDepth === 0 && currentObj.trim()) {
      try {
        const event = JSON.parse(currentObj);
        
        // Skip events that don't have billing metrics
        if (event.wallTime !== undefined && event.cpuTime !== undefined) {
          // Normalize to standard format (matching R2 Logpush format)
          const normalizedLog = {
            ScriptName: event.scriptName,
            EventType: event.event?.type || 'fetch',
            EventTimestampMs: event.eventTimestamp,
            WallTimeMs: event.wallTime,
            CPUTimeMs: event.cpuTime,
            Outcome: event.outcome,
            ExecutionModel: event.executionModel,
            Entrypoint: event.entrypoint,
            DurableObjectId: event.durableObjectId
          };
          
          // Apply filters if provided
          if (scriptName && normalizedLog.ScriptName !== scriptName) {
            // Skip - doesn't match filter
          } else if (startTime && normalizedLog.EventTimestampMs < startTime.getTime()) {
            // Skip - before time window
          } else if (endTime && normalizedLog.EventTimestampMs > endTime.getTime()) {
            // Skip - after time window
          } else {
            logs.push(normalizedLog);
          }
        }
      } catch (e) {
        // Skip malformed JSON
      }
      
      currentObj = '';
    }
  }
  
  console.log(`   ✅ Parsed ${logs.length} log entries`);
  
  // Group by execution model for debugging
  const byModel = {};
  logs.forEach(log => {
    const model = log.ExecutionModel || 'unknown';
    byModel[model] = (byModel[model] || 0) + 1;
  });
  console.log(`   📊 Execution models:`, byModel);
  
  return logs;
}

/**
 * Fetch billing metrics from wrangler tail logs
 * 
 * @param {string} tailLogPath - Path to tail log file
 * @param {string} scriptName - Script name to filter
 * @param {number} batchStartTime - Batch start timestamp (ms)
 * @param {number} batchEndTime - Batch end timestamp (ms)
 * @param {number} expectedCount - Expected number of operations
 * @param {Object} options - Additional options
 * @param {Function} options.logFilter - Optional function to filter logs (log) => boolean
 * @param {string} options.approach - Approach name for logging (e.g., 'direct', 'proxyfetch')
 * @returns {Object} Billing metrics
 */
export function fetchBillingMetricsFromTail(tailLogPath, scriptName, batchStartTime, batchEndTime, expectedCount, options = {}) {
  // Use very tight time windows to avoid overlap between sequential batches
  // Wrangler tail is real-time, so minimal buffers needed
  const bufferBefore = options.bufferBeforeMs || 1000; // 1s before (for clock skew)
  const bufferAfter = options.bufferAfterMs || 2000; // 2s after (for log capture delay)
  
  // Use the actual batch window with minimal buffers
  const searchStart = new Date(batchStartTime - bufferBefore);
  const searchEnd = new Date(batchEndTime + bufferAfter);
  
  console.log(`\n⏱️  Extracting billing metrics${options.approach ? ` (${options.approach})` : ''}...`);
  console.log(`   Batch window: ${new Date(batchStartTime).toISOString()} - ${new Date(batchEndTime).toISOString()}`);
  console.log(`   Search window: ${searchStart.toISOString()} - ${searchEnd.toISOString()}`);
  console.log(`   Expecting: ${expectedCount} log entries`);
  
  // Parse tail logs with time/script filters
  let logs = parseWranglerTailLogs(tailLogPath, scriptName, searchStart, searchEnd);
  
  // Apply additional filter if provided (e.g., filter by entrypoint/executionModel)
  if (options.logFilter) {
    const beforeCount = logs.length;
    logs = logs.filter(options.logFilter);
    console.log(`   Filtered: ${beforeCount} → ${logs.length} logs`);
    
    // Show time range of matched logs for debugging
    if (logs.length > 0) {
      const timestamps = logs.map(l => l.EventTimestampMs).filter(Boolean);
      if (timestamps.length > 0) {
        const minTime = new Date(Math.min(...timestamps)).toISOString();
        const maxTime = new Date(Math.max(...timestamps)).toISOString();
        console.log(`   Matched log time range: ${minTime} - ${maxTime}`);
      }
    }
  }
  
  // Extract metrics (pass approach name for special handling)
  return extractMetricsFromLogs(logs, expectedCount, options.approach);
}

/**
 * Generate mock log entries for local testing
 * 
 * @param {string} scriptName - Script name
 * @param {number} count - Number of logs to generate
 * @param {Date} startTime - Start time for timestamps
 * @returns {Array} Mock log entries
 */
function generateMockLogs(scriptName, count, startTime) {
  const logs = [];
  
  for (let i = 0; i < count; i++) {
    // Simulate realistic billing times
    // For proxy-fetch, we expect:
    // - Direct: ~150ms wall time (baseline)
    // - Current: ~25ms origin DO + ~5ms orchestrator DO
    // - Simple: ~20ms origin DO
    
    const mockLog = {
      ScriptName: scriptName,
      EventType: 'fetch',
      EventTimestampMs: startTime.getTime() + (i * 100), // Spread over time
      WallTimeMs: 20 + Math.random() * 10, // Mock: 20-30ms (proxyFetchSimple range)
      CPUTimeMs: 5 + Math.random() * 3,    // Mock: 5-8ms (Worker CPU)
      Outcome: 'ok'
    };
    
    logs.push(mockLog);
  }
  
  return logs;
}

/**
 * Query R2 bucket for log files in date range
 * 
 * @param {S3Client} client - S3 client
 * @param {string} datePrefix - Date prefix (e.g., '2025-11-18')
 * @returns {Promise<Array>} Array of log file keys
 */
async function listLogFiles(client, datePrefix) {
  const command = new ListObjectsV2Command({
    Bucket: R2_CONFIG.bucketName,
    Prefix: datePrefix,
    MaxKeys: 1000
  });
  
  const response = await client.send(command);
  return response.Contents?.map(obj => obj.Key) || [];
}

/**
 * Download and parse a log file from R2
 * 
 * @param {S3Client} client - S3 client
 * @param {string} key - Object key
 * @returns {Promise<Array>} Parsed log entries (JSONL)
 */
async function downloadAndParseLogFile(client, key) {
  const command = new GetObjectCommand({
    Bucket: R2_CONFIG.bucketName,
    Key: key
  });
  
  const response = await client.send(command);
  const stream = Readable.from(response.Body);
  
  // Check if file is gzipped
  const isGzipped = key.endsWith('.gz');
  const dataStream = isGzipped ? stream.pipe(createGunzip()) : stream;
  
  // Collect chunks
  const chunks = [];
  for await (const chunk of dataStream) {
    chunks.push(chunk);
  }
  
  const content = Buffer.concat(chunks).toString('utf8');
  
  // Parse JSONL (one JSON object per line)
  const logs = [];
  for (const line of content.split('\n')) {
    if (line.trim()) {
      try {
        const logEntry = JSON.parse(line);
        // Extract $workers.event data if present
        if (logEntry.$workers) {
          logs.push({
            ScriptName: logEntry.$workers.scriptName,
            EventType: logEntry.$workers.eventType,
            EventTimestampMs: logEntry.$workers.event?.request?.timestamp || Date.now(),
            WallTimeMs: logEntry.$workers.wallTimeMs || 0,
            CPUTimeMs: logEntry.$workers.cpuTimeMs || 0,
            Outcome: logEntry.$workers.outcome,
            RequestId: logEntry.$workers.requestId,
            RayId: logEntry.$workers.event?.rayId
          });
        }
      } catch (e) {
        // Skip malformed lines
      }
    }
  }
  
  return logs;
}

/**
 * Filter logs by time window and script name
 * 
 * @param {Array} logs - All log entries
 * @param {string} scriptName - Script name to filter
 * @param {Date} startTime - Start of window
 * @param {Date} endTime - End of window
 * @returns {Array} Filtered logs
 */
function filterLogsByTimeWindow(logs, scriptName, startTime, endTime) {
  const startMs = startTime.getTime();
  const endMs = endTime.getTime();
  
  return logs.filter(log => {
    // Filter by script name
    if (log.ScriptName !== scriptName) {
      return false;
    }
    
    // Filter by time window
    const logTime = log.EventTimestampMs;
    return logTime >= startMs && logTime <= endMs;
  });
}

// Export config for testing/debugging
export const config = R2_CONFIG;

