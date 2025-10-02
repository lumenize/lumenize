/**
 * Types for documentation testing extractor
 */

export interface CodeBlock {
  language: string;
  metadata: string;
  code: string;
  line: number;
}

export interface FileContent {
  content: string;
  append: boolean;
}

export interface ExtractionContext {
  // Source document
  sourceFile: string;
  sourcePath: string;
  
  // Output workspace
  workspaceDir: string;
  
  // Accumulated files
  files: Map<string, FileContent>;
  
  // Dependencies detected from imports
  dependencies: Set<string>;
  
  // Errors encountered
  errors: string[];
}

export interface CodeBlockHandler {
  name: string;
  matches: (language: string, metadata: string) => boolean;
  extract: (code: string, metadata: string, line: number, context: ExtractionContext) => void;
}

export interface ExtractionResult {
  workspaceDir: string;
  sourceFile: string;
  filesWritten: string[];
  dependencies: string[];
  errors: string[];
  success: boolean;
}

export interface ExtractorOptions {
  docsDir: string;
  outputDir: string;
  verbose?: boolean;
}
