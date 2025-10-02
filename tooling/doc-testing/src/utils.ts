/**
 * Utility functions for documentation testing
 */

/**
 * Parse import statements from TypeScript/JavaScript code to detect dependencies
 */
export function parseImports(code: string): Set<string> {
  const dependencies = new Set<string>();
  
  // Match: import ... from 'package-name'
  // Match: import ... from "package-name"
  const importRegex = /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g;
  
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    const importPath = match[1];
    
    // Skip relative imports (./... or ../...)
    if (importPath.startsWith('.')) {
      continue;
    }
    
    // Skip node: protocol imports
    if (importPath.startsWith('node:')) {
      continue;
    }
    
    // Skip cloudflare: protocol imports (built-in to Workers)
    if (importPath.startsWith('cloudflare:')) {
      continue;
    }
    
    // Extract package name (handle scoped packages)
    // Examples: @lumenize/rpc, vitest, @cloudflare/workers-types
    let packageName = importPath;
    if (importPath.startsWith('@')) {
      // Scoped package: @scope/package or @scope/package/subpath
      const parts = importPath.split('/');
      packageName = `${parts[0]}/${parts[1]}`;
    } else {
      // Regular package: package or package/subpath
      packageName = importPath.split('/')[0];
    }
    
    dependencies.add(packageName);
  }
  
  return dependencies;
}

/**
 * Extract filename from metadata
 * Examples:
 * - "test" -> "extracted.test.ts"
 * - "test:counter.test.ts" -> "counter.test.ts"
 * - "src/index.ts" -> "src/index.ts"
 */
export function extractFilename(metadata: string, defaultName: string): string {
  const parts = metadata.split(':');
  if (parts.length > 1) {
    // Has explicit filename after colon
    return parts[1].trim();
  }
  
  // Check if metadata itself is a path
  if (metadata.includes('/') || metadata.includes('.')) {
    return metadata;
  }
  
  return defaultName;
}

/**
 * Determine if code block should be skipped
 */
export function shouldSkip(metadata: string): boolean {
  return metadata.includes(':skip') || metadata.includes('skip');
}
