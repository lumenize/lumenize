#!/usr/bin/env node

/**
 * CLI for extracting documentation tests
 */

import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { extractFromMarkdown } from './extractor.js';

interface CliOptions {
  docsDir?: string;
  outputDir: string;
  file?: string;
  verbose: boolean;
}

async function findMdxFiles(dir: string): Promise<string[]> {
  const mdxFiles: string[] = [];
  
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const subFiles = await findMdxFiles(fullPath);
      mdxFiles.push(...subFiles);
    } else if (entry.isFile() && (entry.name.endsWith('.mdx') || entry.name.endsWith('.md'))) {
      mdxFiles.push(fullPath);
    }
  }
  
  return mdxFiles;
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const options: CliOptions = {
    outputDir: '',
    verbose: false,
  };
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--docs-dir' && i + 1 < args.length) {
      options.docsDir = args[++i];
    } else if (arg === '--file' && i + 1 < args.length) {
      options.file = args[++i];
    } else if (arg === '--output-dir' && i + 1 < args.length) {
      options.outputDir = args[++i];
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === 'extract') {
      // Command name, skip
      continue;
    }
  }
  
  if ((!options.docsDir && !options.file) || !options.outputDir) {
    console.error('Usage: doc-testing [--docs-dir <dir> | --file <file>] --output-dir <dir> [--verbose]');
    console.error('');
    console.error('Examples:');
    console.error('  # Extract all docs');
    console.error('  doc-testing --docs-dir ./docs --output-dir ./test/extracted');
    console.error('');
    console.error('  # Extract single file');
    console.error('  doc-testing --file ./docs/rpc/quick-start.mdx --output-dir ./test/extracted');
    process.exit(1);
  }
  
  console.log('Extracting code blocks from documentation...');
  console.log(`  Output dir: ${options.outputDir}`);
  
  // Determine which files to process
  let mdxFiles: string[];
  if (options.file) {
    console.log(`  File: ${options.file}`);
    mdxFiles = [options.file];
  } else if (options.docsDir) {
    console.log(`  Docs dir: ${options.docsDir}`);
    mdxFiles = await findMdxFiles(options.docsDir);
    console.log(`  Found ${mdxFiles.length} documentation files`);
  } else {
    mdxFiles = [];
  }
  console.log('');
  
  // Extract from each file
  const results = [];
  for (const mdxFile of mdxFiles) {
    if (options.verbose) {
      console.log(`Processing ${mdxFile}...`);
    }
    
    const result = await extractFromMarkdown(mdxFile, options.outputDir, options.verbose);
    results.push(result);
    
    if (result.errors.length > 0) {
      console.error(`❌ Errors in ${result.sourceFile}:`);
      for (const error of result.errors) {
        console.error(`   ${error}`);
      }
      console.error('');
    } else if (result.filesWritten.length > 0) {
      console.log(`✅ ${result.sourceFile}: ${result.filesWritten.length} files extracted`);
    }
  }
  
  console.log('');
  
  // Summary
  const successful = results.filter(r => r.success && r.filesWritten.length > 0).length;
  const failed = results.filter(r => !r.success).length;
  const skipped = results.filter(r => r.success && r.filesWritten.length === 0).length;
  
  console.log('Summary:');
  console.log(`  ✅ Extracted: ${successful}`);
  console.log(`  ⏭️  Skipped: ${skipped} (no testable code)`);
  console.log(`  ❌ Failed: ${failed}`);
  
  // Exit with error if any failed
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
