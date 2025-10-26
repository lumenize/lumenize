#!/usr/bin/env node

/**
 * Measures the minified + gzipped size of a package's main export.
 * Bundles all .js files from the dist directory.
 * 
 * Usage: node scripts/measure-package-size.js <package-path>
 * Example: node scripts/measure-package-size.js packages/rpc
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve, join, extname } from 'path';
import { gzipSync } from 'zlib';
import { minify } from 'terser';

function getAllJsFiles(dirPath) {
  const files = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllJsFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(fullPath);
    }
  }
  
  return files;
}

async function measurePackageSize(packagePath) {
  const packageJsonPath = resolve(packagePath, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  
  console.log(`\n📦 Measuring package: ${packageJson.name}@${packageJson.version}\n`);
  
  // Get all .js files from dist
  const distPath = resolve(packagePath, 'dist');
  const jsFiles = getAllJsFiles(distPath);
  
  if (jsFiles.length === 0) {
    console.error('❌ No .js files found in dist directory');
    console.error('\nMake sure to build the package first');
    process.exit(1);
  }
  
  console.log(`📁 Found ${jsFiles.length} JavaScript files\n`);
  
  // Concatenate all source code
  let combinedSource = '';
  for (const file of jsFiles) {
    const content = readFileSync(file, 'utf-8');
    // Remove sourcemap comments
    const cleanedContent = content.replace(/\/\/# sourceMappingURL=.*/g, '');
    combinedSource += cleanedContent + '\n';
  }
  
  // Original size
  const originalSize = Buffer.from(combinedSource).length;
  console.log(`📄 Original (all files): ${(originalSize / 1024).toFixed(2)} KB`);
  
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
  
  return {
    original: originalSize,
    minified: minifiedSize,
    gzipped: gzippedSize,
  };
}

const packagePath = process.argv[2] || 'packages/rpc';
measurePackageSize(packagePath).catch(console.error);
