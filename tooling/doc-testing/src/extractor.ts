/**
 * Main extractor - parses .mdx files and extracts code blocks
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdx from 'remark-mdx';
import { visit } from 'unist-util-visit';
import { readFile } from 'fs/promises';
import { basename, join, relative } from 'path';
import type { Code } from 'mdast';
import type { ExtractionContext, ExtractionResult, CodeBlockHandler } from './types.js';
import { TestHandler, WranglerHandler, SourceHandler, PackageHandler, VitestConfigHandler } from './handlers/index.js';
import { writeWorkspace } from './workspace-builder.js';

const handlers: CodeBlockHandler[] = [
  new TestHandler(),
  new WranglerHandler(),
  new SourceHandler(),
  new PackageHandler(),
  new VitestConfigHandler(),
];

export async function extractFromMarkdown(
  mdxFilePath: string,
  outputBaseDir: string,
  verbose = false
): Promise<ExtractionResult> {
  // Read the .mdx file
  const content = await readFile(mdxFilePath, 'utf-8');
  
  // Create extraction context
  const context: ExtractionContext = {
    sourceFile: basename(mdxFilePath),
    sourcePath: mdxFilePath,
    workspaceDir: join(outputBaseDir, basename(mdxFilePath, '.mdx')),
    files: new Map(),
    dependencies: new Set(),
    errors: [],
  };
  
  // Parse markdown
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkMdx);
  
  const tree = processor.parse(content);
  
  // Visit all code blocks
  visit(tree, 'code', (node: Code) => {
    const { lang, meta, value, position } = node;
    
    if (!lang || !meta) {
      return; // Skip blocks without language or metadata
    }
    
    const line = position?.start.line ?? 0;
    
    if (verbose) {
      console.log(`  Found code block: ${lang} ${meta} (line ${line})`);
    }
    
    // Find matching handler
    for (const handler of handlers) {
      if (handler.matches(lang, meta)) {
        if (verbose) {
          console.log(`  -> Handled by ${handler.name}`);
        }
        handler.extract(value, meta, line, context);
        return; // Only one handler per block
      }
    }
  });
  
  // Check for errors
  if (context.errors.length > 0) {
    return {
      workspaceDir: context.workspaceDir,
      sourceFile: context.sourceFile,
      filesWritten: [],
      dependencies: Array.from(context.dependencies),
      errors: context.errors,
      success: false,
    };
  }
  
  // Write workspace if we extracted any files
  let filesWritten: string[] = [];
  if (context.files.size > 0) {
    filesWritten = await writeWorkspace(context);
    
    if (verbose) {
      console.log(`  Wrote ${filesWritten.length} files to ${context.workspaceDir}`);
    }
  } else {
    if (verbose) {
      console.log(`  No testable code blocks found, skipping workspace creation`);
    }
  }
  
  return {
    workspaceDir: context.workspaceDir,
    sourceFile: context.sourceFile,
    filesWritten,
    dependencies: Array.from(context.dependencies),
    errors: context.errors,
    success: true,
  };
}
