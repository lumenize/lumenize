/**
 * Build and write test workspace
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { ExtractionContext } from './types.js';
import { generatePackageJson } from './package-generator.js';
import { generateVitestConfig } from './vitest-config-generator.js';

export async function writeWorkspace(context: ExtractionContext): Promise<string[]> {
  const filesWritten: string[] = [];
  
  // Create workspace directory
  await mkdir(context.workspaceDir, { recursive: true });
  
  // Write all extracted files
  for (const [relativePath, fileContent] of context.files) {
    const fullPath = join(context.workspaceDir, relativePath);
    
    // Create directory if needed
    await mkdir(dirname(fullPath), { recursive: true });
    
    // Write file
    await writeFile(fullPath, fileContent.content, 'utf-8');
    filesWritten.push(relativePath);
  }
  
  // Generate package.json if not provided
  if (!context.files.has('package.json')) {
    const packageJsonContent = generatePackageJson(context);
    const packageJsonPath = join(context.workspaceDir, 'package.json');
    await writeFile(packageJsonPath, packageJsonContent, 'utf-8');
    filesWritten.push('package.json');
  }
  
  // Generate vitest.config.ts if not provided
  if (!context.files.has('vitest.config.ts')) {
    const vitestConfigContent = generateVitestConfig();
    const vitestConfigPath = join(context.workspaceDir, 'vitest.config.ts');
    await writeFile(vitestConfigPath, vitestConfigContent, 'utf-8');
    filesWritten.push('vitest.config.ts');
  }
  
  return filesWritten;
}
