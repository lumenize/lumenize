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

/** A request's or response's field that goes through a field callback. */
export type SyncField = 'headers' | 'body';

// Used when the functions below are called standalone: headers as
// `[name, value]` pairs, and the body as it is, for a carrier such as Workers
// RPC that clones it. `preprocess` passes its own callback, which encodes
// both fields like any other value.
function defaultEncodeField(value: any, field: SyncField): any {
  return field === 'headers' ? headersToArray(value) : value;
}

function defaultDecodeField(data: any, field: SyncField): any {
  if (field === 'body' || data instanceof Headers) return data;
  return new Headers(data);
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
 * @param [encodeField] - Encodes the headers and the body
 * @returns Plain object suitable for RPC/Queue transmission
 */
export function encodeRequestSync(
  request: RequestSync,
  encodeField: (value: any, field: SyncField) => any = defaultEncodeField
): any {
  return {
    url: request.url,
    method: request.method,
    headers: encodeField(request.headers, 'headers'),
    body: encodeField(request.body, 'body'),
  };
}

/**
 * Decode plain object to RequestSync instance.
 * 
 * Inverse of encodeRequestSync(). Use this on the receiving end of
 * an RPC call or Queue message to reconstruct the RequestSync object.
 * 
 * @param data - Encoded request data
 * @param [decodeField] - Decodes the headers and the body
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
  decodeField: (data: any, field: SyncField) => any = defaultDecodeField
): RequestSync {
  return new RequestSync(data.url, {
    method: data.method,
    headers: decodeField(data.headers, 'headers'),
    body: decodeField(data.body, 'body'),
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
 * @param [encodeField] - Encodes the headers and the body
 * @returns Plain object suitable for RPC/Queue transmission
 */
export function encodeResponseSync(
  response: ResponseSync,
  encodeField: (value: any, field: SyncField) => any = defaultEncodeField
): any {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: encodeField(response.headers, 'headers'),
    body: encodeField(response.body, 'body'),
  };
}

/**
 * Decode plain object to ResponseSync instance.
 * 
 * Inverse of encodeResponseSync(). Use this on the receiving end of
 * an RPC call or Queue message to reconstruct the ResponseSync object.
 * 
 * @param data - Encoded response data
 * @param [decodeField] - Decodes the headers and the body
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
  decodeField: (data: any, field: SyncField) => any = defaultDecodeField
): ResponseSync {
  return new ResponseSync(decodeField(data.body, 'body'), {
    status: data.status,
    statusText: data.statusText,
    headers: decodeField(data.headers, 'headers'),
  });
}
