/**
 * Handler for source file code blocks
 */

import type { CodeBlockHandler, ExtractionContext } from '../types.js';
import { parseImports } from '../utils.js';

export class SourceHandler implements CodeBlockHandler {
  name = 'SourceHandler';
  
  matches(language: string, metadata: string): boolean {
    // Metadata should be a file path like: src/index.ts
    return (language === 'typescript' || language === 'javascript' || language === 'ts' || language === 'js') &&
           (metadata.startsWith('src/') || metadata.includes('.ts') || metadata.includes('.js'));
  }
  
  extract(code: string, metadata: string, line: number, context: ExtractionContext): void {
    // Use metadata as file path
    const filePath = metadata;
    
    // Check if this file already exists - if so, append
    const existing = context.files.get(filePath);
    if (existing) {
      // Append with separator (like TestHandler does)
      context.files.set(filePath, {
        content: existing.content + '\n\n' + code,
        append: true,
      });
    } else {
      // First occurrence - set as new file
      context.files.set(filePath, {
        content: code,
        append: false,
      });
    }
    
    // Parse imports for dependencies
    const imports = parseImports(code);
    for (const dep of imports) {
      context.dependencies.add(dep);
    }
  }
}
