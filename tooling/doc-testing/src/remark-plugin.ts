/**
 * Remark plugin for extracting testable code from MDX documentation
 * 
 * This plugin runs during the Docusaurus build process and extracts code blocks
 * into executable test workspaces under website/test/extracted/
 */

import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';
import type { VFile } from 'vfile';
import path from 'path';
import { extractFromMarkdown } from './extractor.js';
import type { ExtractionResult } from './types.js';

export interface RemarkTestableDocsOptions {
  /**
   * Output directory for extracted test workspaces
   * Relative to website root
   * @default 'test/extracted'
   */
  outputDir?: string;

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;

  /**
   * Skip test extraction (useful for development)
   * @default false
   */
  skip?: boolean;
}

/**
 * Remark plugin that extracts testable code blocks from MDX files
 * 
 * Usage in docusaurus.config.ts:
 * ```ts
 * import remarkTestableDocs from '@lumenize/doc-testing/remark-plugin';
 * 
 * export default {
 *   presets: [
 *     [
 *       'classic',
 *       {
 *         docs: {
 *           remarkPlugins: [
 *             [remarkTestableDocs, { 
 *               outputDir: 'test/extracted',
 *               verbose: true 
 *             }]
 *           ],
 *         },
 *       },
 *     ],
 *   ],
 * };
 * ```
 */
export default function remarkTestableDocs(options: RemarkTestableDocsOptions = {}) {
  const { 
    outputDir = 'test/extracted',
    verbose = false,
    skip = false,
  } = options;

  return async function transformer(tree: Root, file: VFile) {
    // Skip if disabled
    if (skip) {
      if (verbose) {
        console.log(`[remark-testable-docs] Skipping ${file.path} (skip=true)`);
      }
      return;
    }

    // Only process .md and .mdx files
    if (!file.path || (!file.path.endsWith('.md') && !file.path.endsWith('.mdx'))) {
      return;
    }

    if (verbose) {
      console.log(`[remark-testable-docs] Processing ${file.path}`);
      console.log(`[remark-testable-docs] Tree children[0]:`, tree.children[0]?.type);
    }

    // Check frontmatter for testable flag
    // In MDX files, frontmatter is in a YAML node at the start of the tree
    let frontmatter: any = {};
    if (tree.children.length > 0 && tree.children[0].type === 'yaml') {
      try {
        // Parse YAML frontmatter
        const yamlContent = (tree.children[0] as any).value;
        // Simple YAML parsing - look for testable: true
        frontmatter = Object.fromEntries(
          yamlContent.split('\n')
            .filter((line: string) => line.includes(':'))
            .map((line: string) => {
              const [key, ...valueParts] = line.split(':');
              const value = valueParts.join(':').trim();
              return [key.trim(), value === 'true' ? true : value === 'false' ? false : value];
            })
        );
      } catch (e) {
        // Failed to parse frontmatter, skip this file
        if (verbose) {
          console.log(`[remark-testable-docs] Could not parse frontmatter in ${file.path}`);
        }
      }
    }
    
    if (!frontmatter.testable) {
      if (verbose) {
        console.log(`[remark-testable-docs] Skipping ${file.path} (no testable: true in frontmatter)`);
      }
      return;
    }

    try {
      // Determine output path based on frontmatter
      let workspacePath: string;
      
      if (typeof frontmatter.testable === 'string') {
        // Custom workspace name: testable: "my-custom-name"
        workspacePath = frontmatter.testable;
      } else {
        // Preserve folder structure from docs/
        // e.g., docs/rpc/quick-start.mdx -> rpc/quick-start
        const docsDir = path.join(file.cwd || process.cwd(), 'docs');
        const relativePath = path.relative(docsDir, file.path);
        workspacePath = relativePath.replace(/\.(mdx?|md)$/, '');
      }
      
      // Create output path relative to website root
      const absoluteOutputDir = path.join(file.cwd || process.cwd(), outputDir, workspacePath);

      if (verbose) {
        console.log(`[remark-testable-docs] Processing ${file.path}`);
        console.log(`[remark-testable-docs] Workspace: ${workspacePath}`);
        console.log(`[remark-testable-docs] Output: ${absoluteOutputDir}`);
      }

      // Extract code blocks using the CLI's extraction function
      // This returns an ExtractionResult and writes files to disk
      const result = await extractFromMarkdown(
        file.path,
        path.dirname(absoluteOutputDir), // outputBaseDir (parent of workspace folder)
        verbose
      );

      // Check if there were any files extracted
      const fileCount = result.filesWritten?.length || 0;
      
      if (fileCount === 0) {
        if (verbose) {
          console.log(`[remark-testable-docs] No testable code found in ${file.path}`);
        }
        return;
      }

      if (verbose) {
        console.log(`[remark-testable-docs] ✅ Extracted ${fileCount} files for ${workspacePath}`);
      }

      // Add a custom property to the file for debugging/testing
      file.data.extractedTests = {
        workspacePath,
        outputDir: absoluteOutputDir,
        fileCount,
        success: result.success,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[remark-testable-docs] Error processing ${file.path}:`, errorMessage);
      
      // Add error to file messages (shows up in Docusaurus build output)
      file.message(
        `Failed to extract testable code: ${errorMessage}`,
        undefined,
        'remark-testable-docs'
      );

      // Don't fail the build, just log the error
      // Users can fix documentation issues without breaking the build
    }
  };
}
