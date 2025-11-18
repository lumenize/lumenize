#!/usr/bin/env node
/**
 * Script to inspect R2 Logpush logs for Workers performance experiments
 * 
 * Usage: node scripts/inspect-r2-logs.js [date]
 * Example: node scripts/inspect-r2-logs.js 2025-11-18
 * 
 * Requires .dev.vars to contain:
 * - CLOUDFLARE_R2_ACCESS_KEY_ID
 * - CLOUDFLARE_R2_SECRET_ACCESS_KEY
 * - CLOUDFLARE_R2_LOGPUSH_URL
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

// Load environment variables from .dev.vars
const devVarsPath = path.join(process.cwd(), '.dev.vars');
if (fs.existsSync(devVarsPath)) {
  const envContent = fs.readFileSync(devVarsPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key] = valueParts.join('=');
      }
    }
  });
}

const BUCKET_NAME = 'cloudflare-managed-03e4752d';
const ACCOUNT_ID = '6c2517e636c90da5abf4e8d2a8eab42f';

// Configure S3 client for R2
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
});

async function listLogs(datePrefix) {
  console.log(`\n📋 Listing logs for ${datePrefix || 'all dates'}...\n`);
  
  const command = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
    Prefix: datePrefix ? `${datePrefix}/` : '',
    MaxKeys: 20, // Limit for inspection
  });

  const response = await s3Client.send(command);
  
  if (!response.Contents || response.Contents.length === 0) {
    console.log('❌ No logs found');
    return [];
  }

  console.log(`✅ Found ${response.Contents.length} log files:\n`);
  response.Contents.forEach((obj, i) => {
    const sizeMB = ((obj.Size || 0) / 1024 / 1024).toFixed(2);
    console.log(`${i + 1}. ${obj.Key} (${sizeMB} MB)`);
  });

  return response.Contents;
}

async function downloadAndParseLogs(key) {
  console.log(`\n📥 Downloading and parsing: ${key}\n`);

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });

  const response = await s3Client.send(command);
  const stream = response.Body;

  // Decompress if gzipped
  const isGzipped = key.endsWith('.gz');
  let dataStream = Readable.from(stream);
  
  if (isGzipped) {
    const gunzip = createGunzip();
    dataStream.pipe(gunzip);
    dataStream = gunzip;
  }

  // Collect data
  const chunks = [];
  for await (const chunk of dataStream) {
    chunks.push(chunk);
  }
  const content = Buffer.concat(chunks).toString('utf-8');

  // Parse JSONL (one JSON object per line)
  const lines = content.trim().split('\n');
  console.log(`📊 Found ${lines.length} log entries\n`);

  // Parse and analyze
  const entries = lines.map(line => {
    try {
      return JSON.parse(line);
    } catch (e) {
      console.error('Failed to parse line:', line.substring(0, 100));
      return null;
    }
  }).filter(Boolean);

  // Group by ScriptName
  const byScript = {};
  entries.forEach(entry => {
    const script = entry.ScriptName || 'unknown';
    if (!byScript[script]) {
      byScript[script] = [];
    }
    byScript[script].push(entry);
  });

  console.log('📈 Summary by Script:\n');
  Object.entries(byScript).forEach(([script, logs]) => {
    const totalWallTime = logs.reduce((sum, log) => sum + (log.WallTimeMs || 0), 0);
    const totalCpuTime = logs.reduce((sum, log) => sum + (log.CPUTimeMs || 0), 0);
    const avgWallTime = (totalWallTime / logs.length).toFixed(2);
    const avgCpuTime = (totalCpuTime / logs.length).toFixed(2);

    console.log(`  ${script}:`);
    console.log(`    Requests: ${logs.length}`);
    console.log(`    Avg Wall Time: ${avgWallTime} ms`);
    console.log(`    Avg CPU Time: ${avgCpuTime} ms`);
    console.log(`    Total Wall Time: ${totalWallTime} ms`);
    console.log(`    Total CPU Time: ${totalCpuTime} ms`);
    
    // Show event type breakdown
    const byEventType = {};
    logs.forEach(log => {
      const type = log.EventType || 'unknown';
      byEventType[type] = (byEventType[type] || 0) + 1;
    });
    console.log(`    Event Types:`, byEventType);
    console.log('');
  });

  // Show first few entries as examples
  console.log('📝 Sample log entries (first 3):\n');
  entries.slice(0, 3).forEach((entry, i) => {
    console.log(`Entry ${i + 1}:`);
    console.log(JSON.stringify(entry, null, 2));
    console.log('');
  });

  return entries;
}

async function main() {
  const dateArg = process.argv[2];
  
  // If no arg or empty string, list all. Otherwise use the provided date.
  const datePrefix = (dateArg && dateArg !== '') ? dateArg : null;

  console.log(`🔍 Searching bucket: ${BUCKET_NAME}`);
  console.log(`📅 Date filter: ${datePrefix || 'none (all logs)'}\n`);

  try {
    // List logs
    const logs = await listLogs(datePrefix);
    
    if (logs.length === 0) {
      console.log('\n💡 Try a different date or wait for Logpush to push logs');
      return;
    }

    // Download and parse first log file
    const firstLog = logs[0];
    await downloadAndParseLogs(firstLog.Key);

    console.log('✅ Done!\n');
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.Code) {
      console.error('Error Code:', error.Code);
    }
    process.exit(1);
  }
}

main();

