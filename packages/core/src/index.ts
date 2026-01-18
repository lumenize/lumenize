/**
 * @lumenize/core - Core injectables for Lumenize
 *
 * Universal utilities for Cloudflare Durable Objects that can be used
 * standalone or auto-injected via LumenizeDO.
 *
 * Note: OCAN (Operation Chaining And Nesting) moved to @lumenize/mesh
 * as it's actor-model infrastructure, not a universal utility.
 *
 * Note: sql moved to @lumenize/mesh and is now built-in to LumenizeDO.
 * It's automatically available on this.svc.sql without any imports.
 */

// Re-export debug from the standalone @lumenize/debug package
// This provides backwards compatibility for existing imports from @lumenize/core
export * from '@lumenize/debug';

