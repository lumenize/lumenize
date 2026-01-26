#!/usr/bin/env node
/**
 * Standalone script to run check-examples plugin
 * Usage:
 *   node scripts/check-examples.mjs [path-to-mdx-file]  # Verify examples
 *   node scripts/check-examples.mjs --report            # Report skip-check counts
 */

import checkExamplesPlugin from '@lumenize/docusaurus-plugin-check-examples';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock Docusaurus LoadContext
const context = {
  siteDir: path.resolve(__dirname, '..'),
  generatedFilesDir: path.resolve(__dirname, '../.docusaurus'),
  siteConfig: {},
  outDir: path.resolve(__dirname, '../build'),
  baseUrl: '/',
};

// Parse command line args
const args = process.argv.slice(2);
const reportMode = args.includes('--report');
const targetFile = args.find((arg) => !arg.startsWith('--'));

// Build options
const options = {
  exclude: ['_archived'], // Match docusaurus.config.ts
  reportMode,
};

if (targetFile) {
  options.include = [targetFile];
}

// Create plugin instance
const plugin = checkExamplesPlugin(context, options);

// Run postBuild hook
try {
  await plugin.postBuild({ outDir: context.outDir });
  if (!reportMode) {
    console.log('\n✅ Check complete!');
  }
  process.exit(0);
} catch (error) {
  console.error('\n❌ Check failed!');
  process.exit(1);
}
