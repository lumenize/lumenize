/**
 * Handler for vitest.config.ts file generation
 */

import type { CodeBlockHandler, ExtractionContext } from '../types.js';

export class VitestConfigHandler implements CodeBlockHandler {
  name = 'VitestConfigHandler';
  
  matches(language: string, metadata: string): boolean {
    return metadata === 'vitest' && 
           (language === 'typescript' || language === 'ts');
  }
  
  extract(code: string, metadata: string, line: number, context: ExtractionContext): void {
    // Only one vitest.config.ts per workspace
    if (context.files.has('vitest.config.ts')) {
      context.errors.push(
        `Multiple vitest.config.ts blocks found in ${context.sourceFile}. Only one is allowed.`
      );
      return;
    }
    
    context.files.set('vitest.config.ts', {
      content: code,
      append: false,
    });
  }
}
