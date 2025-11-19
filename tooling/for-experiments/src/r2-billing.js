/**
 * R2 Billing Analysis for Experiments
 * 
 * Queries Cloudflare Logpush logs from R2 to extract wall clock billing metrics.
 * 
 * Phase A (Current): Mock implementation for local development
 * Phase B (Future): Real R2 polling and log matching in production
 */

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
 * @param {Array} logs - Array of log entries
 * @param {number} expectedCount - Expected number of logs
 * @returns {Object} Aggregated metrics
 */
function extractMetricsFromLogs(logs, expectedCount) {
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
  if (logs.length !== expectedCount) {
    console.warn(`⚠️  Log count mismatch: expected ${expectedCount}, found ${logs.length}`);
  }
  
  return metrics;
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

