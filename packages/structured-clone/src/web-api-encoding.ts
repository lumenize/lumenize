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
 * Shared helper: Read Request body
 * 
 * Reads as ArrayBuffer to support both text and binary data. This handles:
 * - Text bodies (JSON, plain text, HTML, etc.)
 * - Binary bodies (images, PDFs, files, etc.)
 * 
 * The tuple encoder will encode ArrayBuffer as base64. During reconstruction,
 * the Request constructor accepts ArrayBuffer and properly decodes it when .text()
 * or .json() is called.
 * 
 * Note: This consumes the request body. If you need the original after encoding,
 * clone the Request before calling encodeRequest().
 */
export async function readRequestBody(request: Request): Promise<ArrayBuffer | null> {
  if (!request.body || request.bodyUsed) {
    return null;
  }
  
  try {
    const buffer = await request.arrayBuffer();
    // Empty body
    if (buffer.byteLength === 0) {
      return null;
    }
    return buffer;
  } catch (e) {
    // Body might already be consumed or not readable
    return null;
  }
}

/**
 * @internal
 * Shared helper: Read Response body
 * 
 * Reads as ArrayBuffer to support both text and binary data. This handles:
 * - Text bodies (JSON, plain text, HTML, etc.)
 * - Binary bodies (images, PDFs, files, etc.)
 * 
 * The tuple encoder will encode ArrayBuffer as base64. During reconstruction,
 * the Response constructor accepts ArrayBuffer and properly decodes it when .text()
 * or .json() is called.
 * 
 * Note: This consumes the response body. If you need the original after encoding,
 * clone the Response before calling encodeResponse().
 */
export async function readResponseBody(response: Response): Promise<ArrayBuffer | null> {
  if (!response.body || response.bodyUsed) {
    return null;
  }
  
  try {
    const buffer = await response.arrayBuffer();
    // Empty body
    if (buffer.byteLength === 0) {
      return null;
    }
    return buffer;
  } catch (e) {
    // Body might already be consumed or not readable
    return null;
  }
}

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

/**
 * Encode Request object to an intermediate form that can be stringified to JSON
 * 
 * Note: This consumes the request body. If you need the original Request after encoding,
 * clone it before calling this function: `request.clone()`
 * 
 * **Why callbacks?** Users can safely ignore the optional `encodeHeaders` and `encodeBody` 
 * callbacks. They are used internally to enable cycle/alias tracking when this object is 
 * embedded in another object.
 * 
 * @param request - The Request to encode
 * @param [encodeHeaders] - Optional callback to encode Headers (default: inline encoding)
 * @param [encodeBody] - Optional callback to encode body (default: inline encoding)
 */
export async function encodeRequest(
  request: Request,
  encodeHeaders: (h: Headers) => any | Promise<any> = defaultEncodeHeaders,
  encodeBody: (b: ArrayBuffer) => any | Promise<any> = defaultEncodeBody
): Promise<any> {
  const body = await readRequestBody(request);
  
  const data: any = {
    url: request.url,
    method: request.method,
    headers: await encodeHeaders(request.headers),
  };
  
  // Optional properties (only include if non-default)
  if (request.redirect !== 'follow') data.redirect = request.redirect;
  if (request.integrity) data.integrity = request.integrity;
  if (request.keepalive) data.keepalive = request.keepalive;
  if (request.mode !== 'cors') data.mode = request.mode;
  if (request.credentials !== 'same-origin') data.credentials = request.credentials;
  if (request.cache !== 'default') data.cache = request.cache;
  if (request.referrer) data.referrer = request.referrer;
  
  if (body !== null) {
    data.body = await encodeBody(body);
  }
  
  return data;
}

/**
 * Encode Response object to an intermediate form that can be stringified to JSON
 * 
 * Note: This consumes the response body. If you need the original Response after encoding,
 * clone it before calling this function: `response.clone()`
 * 
 * **Why callbacks?** Users can safely ignore the optional `encodeHeaders` and `encodeBody` 
 * callbacks. They are used internally to enable cycle/alias tracking when this object is 
 * embedded in another object.
 * 
 * @param response - The Response to encode
 * @param [encodeHeaders] - Optional callback to encode Headers (default: inline encoding)
 * @param [encodeBody] - Optional callback to encode body (default: inline encoding)
 */
export async function encodeResponse(
  response: Response,
  encodeHeaders: (h: Headers) => any | Promise<any> = defaultEncodeHeaders,
  encodeBody: (b: ArrayBuffer) => any | Promise<any> = defaultEncodeBody
): Promise<any> {
  const body = await readResponseBody(response);
  
  const data: any = {
    status: response.status,
    statusText: response.statusText,
    headers: await encodeHeaders(response.headers),
  };
  
  // Optional properties
  if (response.ok !== undefined) data.ok = response.ok;
  if (response.redirected !== undefined) data.redirected = response.redirected;
  if (response.type) data.type = response.type;
  if (response.url) data.url = response.url;
  
  if (body !== null) {
    data.body = await encodeBody(body);
  }
  
  return data;
}

/**
 * Decode from an intermediate form to a Request object
 * 
 * **Why callbacks?** Users can safely ignore the optional `decodeHeaders` and `decodeBody` 
 * callbacks. They are used internally to enable cycle/alias tracking when this object is 
 * embedded in another object.
 * 
 * @param data - The encoded Request data
 * @param [decodeHeaders] - Optional callback to decode Headers (default: inline decoding)
 * @param [decodeBody] - Optional callback to decode body (default: inline decoding)
 */
export function decodeRequest(
  data: any,
  decodeHeaders: (h: any) => Headers = defaultDeencodeHeaders,
  decodeBody: (b: any) => ArrayBuffer = defaultDeencodeBody
): Request {
  const init: RequestInit = {
    method: data.method,
    headers: decodeHeaders(data.headers),
  };
  
  // Optional properties
  if (data.redirect) init.redirect = data.redirect;
  if (data.integrity) init.integrity = data.integrity;
  if (data.keepalive) init.keepalive = data.keepalive;
  if (data.mode) init.mode = data.mode;
  if (data.credentials) init.credentials = data.credentials;
  if (data.cache) init.cache = data.cache;
  if (data.referrer) init.referrer = data.referrer;
  
  if (data.body !== undefined) {
    init.body = decodeBody(data.body);
  }
  
  return new Request(data.url, init);
}

/**
 * Decode from an intermediate form to a Response object
 * 
 * **Why callbacks?** Users can safely ignore the optional `decodeHeaders` and `decodeBody` 
 * callbacks. They are used internally to enable cycle/alias tracking when this object is 
 * embedded in another object.
 * 
 * @param data - The encoded Response data
 * @param [decodeHeaders] - Optional callback to decode Headers (default: inline decoding)
 * @param [decodeBody] - Optional callback to decode body (default: inline decoding)
 */
export function decodeResponse(
  data: any,
  decodeHeaders: (h: any) => Headers = defaultDeencodeHeaders,
  decodeBody: (b: any) => ArrayBuffer = defaultDeencodeBody
): Response {
  const init: ResponseInit = {
    status: data.status,
    statusText: data.statusText,
    headers: decodeHeaders(data.headers),
  };
  
  const body = data.body !== undefined ? decodeBody(data.body) : null;
  return new Response(body, init);
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
 * 
 * @example
 * ```typescript
 * const reqSync = new RequestSync('https://api.example.com/data', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: { foo: 'bar' }
 * });
 * 
 * const encoded = encodeRequestSync(reqSync);
 * // Send over RPC or Queue
 * await stub.handleRequest(encoded);
 * ```
 */
export async function encodeRequestSync(
  request: RequestSync,
  encodeHeaders: (h: Headers) => any = defaultEncodeHeaders
): Promise<any> {
  return {
    url: request.url,
    method: request.method,
    headers: await encodeHeaders(request.headers),
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
 * @returns Plain object suitable for RPC/Queue transmission
 * 
 * @example
 * ```typescript
 * const response = await fetch('https://api.example.com/data');
 * const body = await response.json();
 * 
 * const respSync = new ResponseSync(body, {
 *   status: response.status,
 *   headers: response.headers
 * });
 * 
 * const encoded = encodeResponseSync(respSync);
 * // Send over RPC or Queue
 * await stub.handleResponse(encoded);
 * ```
 */
export async function encodeResponseSync(
  response: ResponseSync,
  encodeHeaders: (h: Headers) => any = defaultEncodeHeaders
): Promise<any> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: await encodeHeaders(response.headers),
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
