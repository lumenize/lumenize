/**
 * Generate package.json for test workspace
 */

import type { ExtractionContext } from './types.js';
import { basename } from 'path';

export interface PackageJson {
  name: string;
  version: string;
  private: boolean;
  type: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function generatePackageJson(context: ExtractionContext): string {
  // Create package name from source file
  const docName = basename(context.sourceFile, '.mdx').replace(/[^a-z0-9-]/gi, '-');
  
  const packageJson: PackageJson = {
    name: `doc-test-${docName}`,
    version: '0.0.0',
    private: true,
    type: 'module',
  };
  
  // Add detected dependencies
  if (context.dependencies.size > 0) {
    packageJson.dependencies = {};
    for (const dep of context.dependencies) {
      // Use workspace:* protocol for monorepo packages
      if (dep.startsWith('@lumenize/')) {
        packageJson.dependencies[dep] = 'workspace:*';
      } else {
        // For external packages, use latest
        packageJson.dependencies[dep] = '*';
      }
    }
  }
  
  // Add common dev dependencies
  packageJson.devDependencies = {
    '@cloudflare/vitest-pool-workers': '^0.5.27',
    '@cloudflare/workers-types': '^4.20241127.0',
    'vitest': '^2.1.8',
    'typescript': '^5.7.3',
  };
  
  return JSON.stringify(packageJson, null, 2);
}
