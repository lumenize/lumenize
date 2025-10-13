/**
 * Types for doc-test plugin that extracts Markdown from test files
 */

/**
 * Configuration for the Docusaurus plugin
 */
export interface DocTestPluginOptions {
  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;

  /**
   * Inject testable documentation notice
   * @default true
   */
  injectNotice?: boolean;
}

/**
 * Represents a block comment containing Markdown
 */
export interface MarkdownBlock {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Represents a TypeScript code block between Markdown comments
 */
export interface CodeBlock {
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Parsed @import directive
 */
export interface ImportDirective {
  language: string;
  filePath: string;
  displayName?: string;
  line: number;
}

/**
 * Parsed test file structure
 */
export interface ParsedTestFile {
  markdownBlocks: MarkdownBlock[];
  codeBlocks: CodeBlock[];
  imports: ImportDirective[];
  title?: string;
}

/**
 * Generated virtual MDX content
 */
export interface VirtualDoc {
  content: string;
  title: string;
  testFile: string;
}

export interface ExtractorOptions {
  docsDir: string;
  outputDir: string;
  verbose?: boolean;
}
