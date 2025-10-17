/**
 * Parser for extracting Markdown from TypeScript test files
 */

import fs from 'fs';
import path from 'path';

/**
 * Parse a TypeScript test file to extract Markdown blocks, code blocks, and imports
 * @param {string} testFilePath - Path to test file
 * @returns {import('./types.js').ParsedTestFile}
 */
export function parseTestFile(testFilePath) {
  const content = fs.readFileSync(testFilePath, 'utf-8');
  const lines = content.split('\n');
  
  const markdownBlocks = [];
  const codeBlocks = [];
  const imports = [];
  
  let inBlockComment = false;
  let currentBlockStart = -1;
  let currentBlockLines = [];
  let lastBlockEnd = -1;
  let title;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Start of block comment
    if (trimmed.startsWith('/*') && !inBlockComment) {
      // Save code block if we have one
      if (lastBlockEnd >= 0 && currentBlockStart < 0) {
        const codeStart = lastBlockEnd + 1;
        const codeEnd = i - 1;
        if (codeEnd >= codeStart) {
          const codeContent = lines.slice(codeStart, codeEnd + 1).join('\n').trim();
          if (codeContent) {
            codeBlocks.push({
              content: codeContent,
              startLine: codeStart + 1,
              endLine: codeEnd + 1,
            });
          }
        }
      }
      
      inBlockComment = true;
      currentBlockStart = i;
      currentBlockLines = [];
      
      // Handle single-line block comment
      if (trimmed.endsWith('*/')) {
        const content = trimmed.slice(2, -2).trim();
        if (content) {
          currentBlockLines.push(content);
        }
        markdownBlocks.push({
          content: currentBlockLines.join('\n'),
          startLine: i + 1,
          endLine: i + 1,
        });
        
        // Extract title from first H1
        if (!title) {
          const h1Match = content.match(/^#\s+(.+)$/);
          if (h1Match) {
            title = h1Match[1];
          }
        }
        
        inBlockComment = false;
        lastBlockEnd = i;
        currentBlockStart = -1;
      } else {
        // Multi-line comment, skip the opening /*
        const firstLine = trimmed.slice(2).trim();
        if (firstLine) {
          currentBlockLines.push(firstLine);
        }
      }
      continue;
    }
    
    // End of block comment
    if (trimmed.endsWith('*/') && inBlockComment) {
      // Get the line without the closing */
      const lastLine = trimmed.slice(0, -2).trim();
      if (lastLine) {
        currentBlockLines.push(lastLine);
      }
      
      const markdownContent = currentBlockLines.join('\n');
      markdownBlocks.push({
        content: markdownContent,
        startLine: currentBlockStart + 1,
        endLine: i + 1,
      });
      
      // Extract title from first H1
      if (!title) {
        const h1Match = markdownContent.match(/^#\s+(.+)$/m);
        if (h1Match) {
          title = h1Match[1];
        }
      }
      
      // Find imports in this block
      const blockImports = parseImports(markdownContent, currentBlockStart);
      imports.push(...blockImports);
      
      inBlockComment = false;
      lastBlockEnd = i;
      currentBlockStart = -1;
      continue;
    }
    
    // Inside block comment
    if (inBlockComment) {
      currentBlockLines.push(line);
    }
  }
  
  // Handle trailing code block
  if (lastBlockEnd >= 0 && lastBlockEnd < lines.length - 1) {
    const codeStart = lastBlockEnd + 1;
    const codeEnd = lines.length - 1;
    const codeContent = lines.slice(codeStart, codeEnd + 1).join('\n').trim();
    if (codeContent) {
      codeBlocks.push({
        content: codeContent,
        startLine: codeStart + 1,
        endLine: codeEnd + 1,
      });
    }
  }
  
  return {
    markdownBlocks,
    codeBlocks,
    imports,
    title,
  };
}

/**
 * Parse @import directives from Markdown content
 * Format: @import {language} "path" [displayName]
 * Or: @import {language} "path"
 * @param {string} markdown - Markdown content
 * @param {number} blockStartLine - Starting line number of block
 * @returns {import('./types.js').ImportDirective[]}
 */
function parseImports(markdown, blockStartLine) {
  const imports = [];
  const lines = markdown.split('\n');
  
  // Regex to match: @import {language} "path" [optional display name]
  const importRegex = /@import\s+\{(\w+)\}\s+"([^"]+)"(?:\s+\[([^\]]+)\])?/g;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;
    
    while ((match = importRegex.exec(line)) !== null) {
      imports.push({
        language: match[1],
        filePath: match[2],
        displayName: match[3],
        line: blockStartLine + i + 1,
      });
    }
  }
  
  return imports;
}

/**
 * Resolve imported file path relative to the test file
 * @param {string} testFilePath - Path to test file
 * @param {string} importPath - Import path to resolve
 * @returns {string}
 */
export function resolveImportPath(testFilePath, importPath) {
  const testDir = path.dirname(testFilePath);
  return path.resolve(testDir, importPath);
}

/**
 * Read imported file content
 * @param {string} testFilePath - Path to test file
 * @param {string} importPath - Import path
 * @returns {string}
 */
export function readImportedFile(testFilePath, importPath) {
  const resolvedPath = resolveImportPath(testFilePath, importPath);
  
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Import file not found: ${resolvedPath}`);
  }
  
  return fs.readFileSync(resolvedPath, 'utf-8');
}
