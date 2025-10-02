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
    
    if (context.files.has(filePath)) {
      context.errors.push(
        `Duplicate source file "${filePath}" in ${context.sourceFile} at line ${line}`
      );
      return;
    }
    
    context.files.set(filePath, {
      content: code,
      append: false,
    });
    
    // Parse imports for dependencies
    const imports = parseImports(code);
    for (const dep of imports) {
      context.dependencies.add(dep);
    }
  }
}
