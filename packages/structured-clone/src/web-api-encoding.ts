/**
 * Web API object encoding utilities
 * 
 * Provides tuple-style encoding for Request, Response, Headers, and URL objects.
 * 
 * Most users should use `stringify()`/`parse()` which handle Web API objects automatically.
 * These utilities are for when you need explicit control over encoding (e.g., custom
 * encoding pipelines, queue storage, or DO persistence with specific formats).
 * 
 * The encoding functions accept callbacks for handling nested objects like Headers,
 * allowing you to return references (e.g., ["$lmz", index]) or inline data as needed.
 */

/**
 * @internal
 * Shared helper: Convert Headers to array of [string, string] pairs
 */
export function headersToArray(headers: Headers): [string, string][] {
  const entries: [string, string][] = [];
  headers.forEach((value, key) => {
    entries.push([key, value]);
  });
  return entries;
}

/**
 * Default Headers encoder - creates inline array format (no alias tracking)
 * 
 * Used when encodeRequest/encodeResponse are called standalone.
 * For full cycle/alias support, the main encoder injects a custom callback.
 */
function defaultEncodeHeaders(headers: Headers): [string, string][] {
  return headersToArray(headers);
}

/**
 * Default body encoder - creates inline array format (no alias tracking)
 * 
 * Used when encodeRequest/encodeResponse are called standalone.
 * For full cycle/alias support, the main encoder injects a custom callback.
 */
function defaultEncodeBody(body: ArrayBuffer): number[] {
  return Array.from(new Uint8Array(body));
}

/**
 * Default Headers decoder - reconstructs from inline array format
 */
function defaultDeencodeHeaders(data: any): Headers {
  if (data instanceof Headers) return data;
  return new Headers(data);
}

/**
 * Default body decoder - reconstructs from inline array format
 */
function defaultDeencodeBody(data: any): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  return data;
}

// ============================================================================
// RequestSync/ResponseSync synchronous encoding functions
// ============================================================================

import { RequestSync } from './request-sync.js';
import { ResponseSync } from './response-sync.js';

/**
 * Encode RequestSync to plain object for RPC/Queue transmission.
 * 
 * This is a synchronous alternative to encodeRequest() that works with
 * RequestSync objects. Use this when you need to send a request over
 * Workers RPC or Cloudflare Queues.
 * 
 * @param request - RequestSync instance
 * @param [encodeHeaders] - Optional callback to encode Headers (for cycle/alias tracking)
 * @returns Plain object suitable for RPC/Queue transmission
 */
export function encodeRequestSync(
  request: RequestSync,
  encodeHeaders: (h: Headers) => any = defaultEncodeHeaders
): any {
  return {
    url: request.url,
    method: request.method,
    headers: encodeHeaders(request.headers),
    body: request.body, // Direct access to stored body
  };
}

/**
 * Decode plain object to RequestSync instance.
 * 
 * Inverse of encodeRequestSync(). Use this on the receiving end of
 * an RPC call or Queue message to reconstruct the RequestSync object.
 * 
 * @param data - Encoded request data
 * @param [decodeHeaders] - Optional callback to decode Headers (for cycle/alias tracking)
 * @returns RequestSync instance
 * 
 * @example
 * ```typescript
 * // In your DO handler
 * handleRequest(encoded: any) {
 *   const reqSync = decodeRequestSync(encoded);
 *   const data = reqSync.json(); // Synchronous!
 * }
 * ```
 */
export function decodeRequestSync(
  data: any,
  decodeHeaders: (h: any) => Headers = defaultDeencodeHeaders
): RequestSync {
  return new RequestSync(data.url, {
    method: data.method,
    headers: decodeHeaders(data.headers),
    body: data.body,
  });
}

/**
 * Encode ResponseSync to plain object for RPC/Queue transmission.
 * 
 * This is a synchronous alternative to encodeResponse() that works with
 * ResponseSync objects. Use this when you need to send a response over
 * Workers RPC or Cloudflare Queues.
 * 
 * @param response - ResponseSync instance
 * @param [encodeHeaders] - Optional callback to encode Headers (for cycle/alias tracking)
 * @returns Plain object suitable for RPC/Queue transmission`
 */
export function encodeResponseSync(
  response: ResponseSync,
  encodeHeaders: (h: Headers) => any = defaultEncodeHeaders
): any {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: encodeHeaders(response.headers),
    body: response.body, // Direct access to stored body
  };
}

/**
 * Decode plain object to ResponseSync instance.
 * 
 * Inverse of encodeResponseSync(). Use this on the receiving end of
 * an RPC call or Queue message to reconstruct the ResponseSync object.
 * 
 * @param data - Encoded response data
 * @param [decodeHeaders] - Optional callback to decode Headers (for cycle/alias tracking)
 * @returns ResponseSync instance
 * 
 * @example
 * ```typescript
 * // In your DO handler
 * handleResponse(encoded: any) {
 *   const respSync = decodeResponseSync(encoded);
 *   const data = respSync.json(); // Synchronous!
 * }
 * ```
 */
export function decodeResponseSync(
  data: any,
  decodeHeaders: (h: any) => Headers = defaultDeencodeHeaders
): ResponseSync {
  return new ResponseSync(data.body, {
    status: data.status,
    statusText: data.statusText,
    headers: decodeHeaders(data.headers),
  });
}
