/**
 * Handler for package.json blocks
 */

import type { CodeBlockHandler, ExtractionContext } from '../types.js';

export class PackageHandler implements CodeBlockHandler {
  name = 'PackageHandler';
  
  matches(language: string, metadata: string): boolean {
    return metadata === 'package' && language === 'json';
  }
  
  extract(code: string, metadata: string, line: number, context: ExtractionContext): void {
    // Only one package.json per workspace
    if (context.files.has('package.json')) {
      context.errors.push(
        `Multiple package.json blocks found in ${context.sourceFile}. Only one is allowed.`
      );
      return;
    }
    
    context.files.set('package.json', {
      content: code,
      append: false,
    });
  }
}
