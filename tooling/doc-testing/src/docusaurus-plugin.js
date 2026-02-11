/**
 * Docusaurus plugin for generating virtual docs from test files
 * 
 * This plugin scans sidebars.ts for doc-test entries and generates virtual .mdx files
 * from the referenced test files during the Docusaurus build process.
 */

import { parseTestFile } from './test-file-parser.js';
import { generateMdxContent } from './mdx-generator.js';
import path from 'path';
import fs from 'fs';

/**
 * @typedef {Object} DocTestEntry
 * @property {string} type - Entry type
 * @property {string} id - Document ID
 * @property {string} testFile - Path to test file
 */

/**
 * Extract doc-test entries from sidebars configuration
 * Looks for sidebar items with customProps.docTest
 * @param {string} sidebarsPath - Path to sidebars.ts
 * @param {string} siteDir - Site directory
 * @returns {DocTestEntry[]}
 */
function extractDocTestEntries(sidebarsPath, siteDir) {
  const entries = [];
  
  // Read and parse the sidebars file
  const sidebarsContent = fs.readFileSync(sidebarsPath, 'utf-8');
  
  // Match pattern: { type: 'doc', id: 'testing/usage', customProps: { docTest: 'path/to/test.ts' } }
  // Uses [^}]*? between id and customProps to avoid matching across object boundaries
  // (e.g., a `link: { type: 'doc', id: '...' }` in one object spanning to a customProps in another)
  const docTestRegex = /{\s*type:\s*['"]doc['"]\s*,\s*id:\s*['"]([^'"]+)['"][^}]*?customProps:\s*{\s*docTest:\s*['"]([^'"]+)['"]\s*}\s*}/gs;
  
  let match;
  while ((match = docTestRegex.exec(sidebarsContent)) !== null) {
    const id = match[1];
    const testFile = match[2];
    
    // Resolve test file path relative to site directory
    const resolvedTestFile = path.resolve(siteDir, '..', testFile);
    
    entries.push({
      type: 'doc-test',
      id,
      testFile: resolvedTestFile,
    });
  }
  
  return entries;
}

/**
 * Docusaurus plugin that generates virtual docs from test files
 * @param {import('@docusaurus/types').LoadContext} context - Docusaurus context
 * @param {import('./types.js').DocTestPluginOptions} options - Plugin options
 * @returns {import('@docusaurus/types').Plugin}
 */
export default function docTestPlugin(context, options = {}) {
  const { verbose = false, injectNotice = true } = options;
  
  // Cache doc-test entries for use by getPathsToWatch
  let cachedDocTestEntries = null;
  
  return {
    name: 'docusaurus-plugin-doc-test',
    
    getPathsToWatch() {
      // Return the test files so Docusaurus watches them for changes
      const siteDir = context.siteDir;
      const sidebarsPath = path.join(siteDir, 'sidebars.ts');
      
      if (!fs.existsSync(sidebarsPath)) {
        return [];
      }
      
      const docTestEntries = extractDocTestEntries(sidebarsPath, siteDir);
      cachedDocTestEntries = docTestEntries; // Cache for loadContent
      
      // Return array of test file paths
      return docTestEntries.map(entry => entry.testFile);
    },
    
    async loadContent() {
      const siteDir = context.siteDir;
      const sidebarsPath = path.join(siteDir, 'sidebars.ts');
      
      if (!fs.existsSync(sidebarsPath)) {
        if (verbose) {
          console.log('⚠️  No sidebars.ts found, skipping doc-test plugin');
        }
        return;
      }
      
      // Use cached entries from getPathsToWatch, or extract if not cached
      const docTestEntries = cachedDocTestEntries || extractDocTestEntries(sidebarsPath, siteDir);
      
      if (docTestEntries.length === 0) {
        if (verbose) {
          console.log('ℹ️  No doc-test entries found in sidebars.ts');
        }
        return;
      }
      
      if (verbose) {
        console.log(`\n🧪 Doc-test plugin: Processing ${docTestEntries.length} test file(s)...\n`);
      }
      
      // Process each doc-test entry
      for (const entry of docTestEntries) {
        try {
          if (verbose) {
            console.log(`  📝 Processing: ${entry.id}`);
            console.log(`     Test file: ${entry.testFile}`);
          }
          
          if (!fs.existsSync(entry.testFile)) {
            console.error(`  ❌ Test file not found: ${entry.testFile}`);
            continue;
          }
          
          // Parse the test file
          const parsed = parseTestFile(entry.testFile);
          
          if (verbose) {
            console.log(`     Found ${parsed.markdownBlocks.length} markdown block(s)`);
            console.log(`     Found ${parsed.codeBlocks.length} code block(s)`);
            console.log(`     Found ${parsed.imports.length} import(s)`);
            if (parsed.title) {
              console.log(`     Title: ${parsed.title}`);
            }
          }
          
          // Generate virtual MDX content
          const virtualDoc = generateMdxContent(parsed, entry.testFile, { injectNotice });
          
          // Write virtual doc to docs directory with .generated.mdx suffix
          // The entry.id already should include .generated if specified in sidebars
          const docsDir = path.join(siteDir, 'docs');
          const docPath = path.join(docsDir, `${entry.id}.mdx`);
          const docDir = path.dirname(docPath);
          
          // Ensure directory exists
          if (!fs.existsSync(docDir)) {
            fs.mkdirSync(docDir, { recursive: true });
          }
          
          // Write the virtual doc
          fs.writeFileSync(docPath, virtualDoc.content, 'utf-8');
          
          if (verbose) {
            console.log(`     ✅ Generated: ${path.relative(siteDir, docPath)}\n`);
          }
        } catch (error) {
          console.error(`  ❌ Failed to process ${entry.id}:`, error);
        }
      }
      
      if (verbose) {
        console.log('✨ Doc-test plugin: Complete\n');
      }
    },
    
    // Run before other plugins that might depend on the docs
    async contentLoaded({ content, actions }) {
      // Nothing to do here - docs are already written to the filesystem
    },
  };
}
