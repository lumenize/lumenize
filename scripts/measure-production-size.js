#!/usr/bin/env node

/**
 * Measures the minified + gzipped size of production code only.
 * Excludes testing-only utilities like Browser and WebSocket shim.
 * 
 * Usage: node scripts/measure-production-size.js
 */

import { readFileSync } from 'fs';
import { resolve, join } from 'path';
import { gzipSync } from 'zlib';
import { minify } from 'terser';

async function measureProductionSize() {
  console.log('\n📦 Measuring production bundle size (RPC client + server + routeDORequest)\n');
  
  // RPC package files (excluding test-only utilities)
  const rpcFiles = [
    'packages/rpc/dist/client.js',
    'packages/rpc/dist/lumenize-rpc-do.js',
    'packages/rpc/dist/http-post-transport.js',
    'packages/rpc/dist/websocket-rpc-transport.js',
    'packages/rpc/dist/transport-factories.js',
    'packages/rpc/dist/types.js',
  ];
  
  // Utils package files (excluding Browser and WebSocket shim)
  const utilsFiles = [
    'packages/utils/dist/route-do-request.js',
    'packages/utils/dist/get-do-namespace-from-path-segment.js',
    'packages/utils/dist/get-do-stub.js',
    'packages/utils/dist/parse-pathname.js',
    'packages/utils/dist/cookie-utils.js',
    'packages/utils/dist/websocket-utils.js',
    'packages/utils/dist/metrics.js',
  ];
  
  const allFiles = [...rpcFiles, ...utilsFiles];
  
  // Read and combine all files
  let combinedSource = '';
  let fileCount = 0;
  
  for (const file of allFiles) {
    try {
      const content = readFileSync(file, 'utf-8');
      const cleanedContent = content.replace(/\/\/# sourceMappingURL=.*/g, '');
      combinedSource += cleanedContent + '\n';
      fileCount++;
    } catch (err) {
      console.warn(`⚠️  Skipping ${file}: ${err.message}`);
    }
  }
  
  console.log(`📁 Bundled ${fileCount} production files\n`);
  
  // Original size
  const originalSize = Buffer.from(combinedSource).length;
  console.log(`📄 Original (production only): ${(originalSize / 1024).toFixed(2)} KB`);
  
  // Minified size
  const minified = await minify(combinedSource, {
    module: true,
    compress: {
      passes: 2,
      pure_getters: true,
      unsafe: true,
    },
    mangle: true,
  });
  
  if (minified.error) {
    console.error('❌ Minification error:', minified.error);
    process.exit(1);
  }
  
  const minifiedSize = Buffer.from(minified.code).length;
  console.log(`🗜️  Minified: ${(minifiedSize / 1024).toFixed(2)} KB`);
  
  // Gzipped size
  const gzipped = gzipSync(minified.code);
  const gzippedSize = gzipped.length;
  console.log(`📦 Minified + Gzipped: ${(gzippedSize / 1024).toFixed(2)} KB`);
  
  // Size reduction
  const reduction = ((1 - gzippedSize / originalSize) * 100).toFixed(1);
  console.log(`\n✅ Total reduction: ${reduction}%`);
  
  // Comparison
  if (gzippedSize < 10 * 1024) {
    console.log(`\n🎉 Under 10 KB! (${(gzippedSize / 1024).toFixed(2)} KB)`);
  } else {
    console.log(`\n⚠️  Over 10 KB (${(gzippedSize / 1024).toFixed(2)} KB)`);
  }
  
  console.log('\n📊 Breakdown:');
  console.log('   - Excludes: Browser class, WebSocket shim (testing only)');
  console.log('   - Includes: RPC client, server, transports, routeDORequest, utilities\n');
  
  return {
    original: originalSize,
    minified: minifiedSize,
    gzipped: gzippedSize,
  };
}

measureProductionSize().catch(console.error);
