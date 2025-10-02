/**
 * Handler for wrangler.jsonc configuration blocks
 */

import type { CodeBlockHandler, ExtractionContext } from '../types.js';

export class WranglerHandler implements CodeBlockHandler {
  name = 'WranglerHandler';
  
  matches(language: string, metadata: string): boolean {
    return metadata === 'wrangler' && (language === 'jsonc' || language === 'json');
  }
  
  extract(code: string, metadata: string, line: number, context: ExtractionContext): void {
    // Only one wrangler.jsonc per workspace
    if (context.files.has('wrangler.jsonc')) {
      context.errors.push(
        `Multiple wrangler.jsonc blocks found in ${context.sourceFile}. Only one is allowed.`
      );
      return;
    }
    
    context.files.set('wrangler.jsonc', {
      content: code,
      append: false,
    });
  }
}
