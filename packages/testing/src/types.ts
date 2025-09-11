/**
 * Options for WebSocket upgrade simulation
 */
export interface WSUpgradeOptions {
  protocols?: string[];
  origin?: string;
  headers?: Record<string, string>;
  timeout?: number;
}