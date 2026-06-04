/**
 * Ambient declarations for vite/vitest-specific import suffixes.
 *
 * The `?raw` suffix is a vite/vitest feature that imports a file's contents
 * as a string at module-load time. Without this declaration, tsc rejects
 * imports like `import schemaTypes from './schema.d.ts?raw'`.
 */

declare module '*?raw' {
  const content: string;
  export default content;
}
