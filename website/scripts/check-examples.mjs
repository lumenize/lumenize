#!/usr/bin/env node
/**
 * Standalone script to run check-examples plugin
 * Usage: node scripts/check-examples.mjs [path-to-mdx-file]
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

// Get specific file from command line args, if provided
const targetFile = process.argv[2];
const options = targetFile
  ? { include: [targetFile] }
  : { exclude: ['_archived'] };  // Match docusaurus.config.ts

// Create plugin instance
const plugin = checkExamplesPlugin(context, options);

// Run postBuild hook
try {
  await plugin.postBuild({ outDir: context.outDir });
  console.log('\n✅ Check complete!');
  process.exit(0);
} catch (error) {
  console.error('\n❌ Check failed!');
  process.exit(1);
}
