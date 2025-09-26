import { WSUpgradeOptions } from './types';

/**
 * Creates a WebSocket upgrade request with proper headers
 * 
 * @param url - The full WebSocket URL (e.g., 'https://example.com/path')
 * @param options - Optional WebSocket upgrade options including sub-protocols, origin, and custom headers
 * @returns Request object configured for WebSocket upgrade
 */
export function createWSUpgradeRequest(url: string, options?: WSUpgradeOptions): Request {
  const headers: Record<string, string> = { 
    Upgrade: "websocket",
    Connection: "upgrade"
  };
  
  if (options?.protocols && options.protocols.length > 0) {
    headers['Sec-WebSocket-Protocol'] = options.protocols.join(', ');
  }

  // Set origin - use explicit option if provided, otherwise derive from URL
  if (options?.origin) {
    headers['Origin'] = options.origin;
  } else {
    // For testing convenience, derive default origin from URL
    // This would be a security risk in production but is fine for testing
    const urlObj = new URL(url);
    headers['Origin'] = urlObj.origin;
  }

  // Merge custom headers, allowing them to override shorthand options
  if (options?.headers) {
    Object.assign(headers, options.headers);
  }

  return new Request(url, { headers });
}