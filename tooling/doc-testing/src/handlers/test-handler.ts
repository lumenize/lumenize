/**
 * Handler for test code blocks
 */

import type { CodeBlockHandler, ExtractionContext } from '../types.js';
import { parseImports, extractFilename, shouldSkip } from '../utils.js';

export class TestHandler implements CodeBlockHandler {
  name = 'TestHandler';
  
  matches(language: string, metadata: string): boolean {
    return metadata.includes('test') && 
           (language === 'typescript' || language === 'javascript' || language === 'ts' || language === 'js');
  }
  
  extract(code: string, metadata: string, line: number, context: ExtractionContext): void {
    // Skip if marked as skip
    if (shouldSkip(metadata)) {
      return;
    }
    
    // Determine test file path
    const filename = extractFilename(metadata, 'extracted.test.ts');
    const testPath = filename.startsWith('test/') ? filename : `test/${filename}`;
    
    // Add to test files (can append multiple test blocks)
    const existing = context.files.get(testPath);
    if (existing) {
      // Append with separator
      context.files.set(testPath, {
        content: existing.content + '\n\n' + code,
        append: true,
      });
    } else {
      context.files.set(testPath, {
        content: code,
        append: true,
      });
    }
    
    // Parse imports to detect dependencies
    const imports = parseImports(code);
    for (const dep of imports) {
      context.dependencies.add(dep);
    }
  }
}
