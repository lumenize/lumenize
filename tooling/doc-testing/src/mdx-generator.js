/**
 * Generator for virtual MDX content from parsed test files
 */

import { readImportedFile } from './test-file-parser.js';

/**
 * Generate virtual MDX content from a parsed test file
 * @param {import('./types.js').ParsedTestFile} parsed - Parsed test file
 * @param {string} testFilePath - Path to test file
 * @param {{ injectNotice?: boolean }} options - Generation options
 * @returns {import('./types.js').VirtualDoc}
 */
export function generateMdxContent(parsed, testFilePath, options = {}) {
  const parts = [];
  
  // Add frontmatter to indicate this is a generated file
  parts.push('---');
  parts.push('generated_by: doc-testing');
  parts.push('---');
  parts.push('');
  
  // Process markdown and code blocks in order
  let markdownIndex = 0;
  let codeIndex = 0;
  
  // Track if we've added the notice
  let noticeAdded = false;
  
  while (markdownIndex < parsed.markdownBlocks.length || codeIndex < parsed.codeBlocks.length) {
    const nextMarkdown = parsed.markdownBlocks[markdownIndex];
    const nextCode = parsed.codeBlocks[codeIndex];
    
    // Determine which comes next based on line numbers
    const useMarkdown = !nextCode || (nextMarkdown && nextMarkdown.startLine < nextCode.startLine);
    
    if (useMarkdown && nextMarkdown) {
      // Process markdown block (with imports)
      let markdownContent = nextMarkdown.content;
      
      // Process @import directives in this block
      const blockImports = parsed.imports.filter(
        imp => imp.line >= nextMarkdown.startLine && imp.line <= nextMarkdown.endLine
      );
      
      for (const imp of blockImports) {
        try {
          const importedContent = readImportedFile(testFilePath, imp.filePath);
          const displayName = imp.displayName || '';
          const codeBlock = generateCodeBlock(imp.language, importedContent, displayName);
          
          // Replace the @import directive with the code block
          const importDirective = `@import {${imp.language}} "${imp.filePath}"${imp.displayName ? ` [${imp.displayName}]` : ''}`;
          markdownContent = markdownContent.replace(importDirective, codeBlock);
        } catch (error) {
          console.error(`Failed to process import: ${imp.filePath}`, error);
          // Leave the directive in place if import fails
        }
      }
      
      // Inject notice after the first H1 if requested
      if (options.injectNotice && !noticeAdded) {
        const h1Match = markdownContent.match(/^(#\s+.+)$/m);
        if (h1Match) {
          const h1Index = markdownContent.indexOf(h1Match[0]);
          const h1End = h1Index + h1Match[0].length;
          
          // Split the content: before H1, H1 line, after H1
          const beforeH1 = markdownContent.substring(0, h1Index);
          const h1Line = h1Match[0];
          const afterH1 = markdownContent.substring(h1End);
          
          // Reconstruct with notice after H1
          markdownContent = beforeH1 + h1Line + '\n\n' + generateTestableNotice() + afterH1;
          noticeAdded = true;
        }
      }
      
      parts.push(markdownContent);
      
      markdownIndex++;
    } else if (nextCode) {
      // Add test code block
      parts.push('\n');
      parts.push(generateCodeBlock('typescript', nextCode.content, 'test'));
      parts.push('\n');
      codeIndex++;
    }
  }
  
  const content = parts.join('\n\n');
  const title = parsed.title || 'Untitled';
  
  return {
    content,
    title,
    testFile: testFilePath,
  };
}

/**
 * Generate a code fence block
 * @param {string} language - Language identifier
 * @param {string} content - Code content
 * @param {string} displayName - Display name for the block
 * @returns {string}
 */
function generateCodeBlock(language, content, displayName = '') {
  const fence = '```';
  const lang = displayName ? `${language} ${displayName}` : language;
  return `${fence}${lang}\n${content}\n${fence}`;
}

/**
 * Generate the testable documentation notice
 * @returns {string}
 */
function generateTestableNotice() {
  return `<details>
<summary><strong>📘 Doc-testing</strong> – Why do these examples look like tests?</summary>

This documentation uses **testable code examples** to ensure accuracy and reliability:

- **Guaranteed accuracy**: All examples are real, working code that runs against the actual library
- **Always up-to-date**: When the library changes, the tests fail and the docs must be updated
- **Copy-paste confidence**: What you see is what works - no outdated or broken examples
- **Real-world patterns**: Tests show complete, runnable scenarios, not just snippets

Ignore the test boilerplate (\`it()\`, \`describe()\`, etc.) - focus on the code inside.

</details>`;
}
