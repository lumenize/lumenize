/**
 * Types for doc-test plugin that extracts Markdown from test files
 */

/**
 * Configuration for the Docusaurus plugin
 * @typedef {Object} DocTestPluginOptions
 * @property {boolean} [verbose=false] - Enable verbose logging
 * @property {boolean} [injectNotice=true] - Inject testable documentation notice
 */

/**
 * Represents a block comment containing Markdown
 * @typedef {Object} MarkdownBlock
 * @property {string} content - Markdown content
 * @property {number} startLine - Starting line number
 * @property {number} endLine - Ending line number
 */

/**
 * Represents a TypeScript code block between Markdown comments
 * @typedef {Object} CodeBlock
 * @property {string} content - Code content
 * @property {number} startLine - Starting line number
 * @property {number} endLine - Ending line number
 */

/**
 * Parsed @import directive
 * @typedef {Object} ImportDirective
 * @property {string} language - Language of imported file
 * @property {string} filePath - Path to file to import
 * @property {string} [displayName] - Display name for the import
 * @property {number} line - Line number where directive appears
 */

/**
 * Parsed test file structure
 * @typedef {Object} ParsedTestFile
 * @property {MarkdownBlock[]} markdownBlocks - Markdown blocks found
 * @property {CodeBlock[]} codeBlocks - Code blocks found
 * @property {ImportDirective[]} imports - Import directives found
 * @property {string} [title] - Extracted title
 */

/**
 * Generated virtual MDX content
 * @typedef {Object} VirtualDoc
 * @property {string} content - MDX content
 * @property {string} title - Document title
 * @property {string} testFile - Source test file path
 */

/**
 * @typedef {Object} ExtractorOptions
 * @property {string} docsDir - Directory containing docs
 * @property {string} outputDir - Output directory
 * @property {boolean} [verbose] - Verbose logging
 */

// Export empty object since this is just a types file
export {};
