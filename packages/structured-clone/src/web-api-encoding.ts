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
 * Encode Request to tuple-style data
 * 
 * Note: This consumes the request body. If you need the original Request after encoding,
 * clone it before calling this function: `request.clone()`
 * 
 * **Why callbacks?** The optional `encodeHeaders` and `encodeBody` callbacks enable
 * cycle/alias tracking when the same Headers or body appears multiple times in your data:
 * 
 * ```typescript
 * const headers = new Headers({'Authorization': 'Bearer token'});
 * const data = {
 *   req1: new Request('https://api.com/users', { headers }),
 *   req2: new Request('https://api.com/posts', { headers }), // Same instance!
 *   sharedHeaders: headers  // After deencoding: all point to same instance
 * };
 * ```
 * 
 * The main encoder (`stringify()`) injects callbacks that track references. When called
 * standalone, defaults create inline data (no alias tracking, but simpler for one-off use).
 * 
 * @param request - Request to encode
 * @param encodeHeaders - Optional: Custom headers encoder for cycle/alias tracking
 * @param encodeBody - Optional: Custom body encoder for cycle/alias tracking
 * @returns Data object with minimal structure
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
 * Encode Response to tuple-style data
 * 
 * Note: This consumes the response body. If you need the original Response after encoding,
 * clone it before calling this function: `response.clone()`
 * 
 * **Why callbacks?** The optional `encodeHeaders` and `encodeBody` callbacks enable
 * cycle/alias tracking. See `encodeRequest()` JSDoc for details and examples.
 * 
 * @param response - Response to encode
 * @param encodeHeaders - Optional: Custom headers encoder for cycle/alias tracking
 * @param encodeBody - Optional: Custom body encoder for cycle/alias tracking
 * @returns Data object with minimal structure
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
 * Deencode Request from tuple-style data
 * 
 * **Why callbacks?** The optional callbacks resolve references when the data contains
 * `["$lmz", index]` markers (for cycle/alias support). When called standalone with
 * inline data, defaults handle reconstruction directly.
 * 
 * @param data - Data object
 * @param decodeHeaders - Optional: Custom headers decoder for resolving references
 * @param decodeBody - Optional: Custom body decoder for resolving references
 * @returns Reconstructed Request instance
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
 * Deencode Response from tuple-style data
 * 
 * **Why callbacks?** The optional callbacks resolve references when the data contains
 * `["$lmz", index]` markers (for cycle/alias support). See `decodeRequest()` for details.
 * 
 * @param data - Data object
 * @param decodeHeaders - Optional: Custom headers decoder for resolving references
 * @param decodeBody - Optional: Custom body decoder for resolving references
 * @returns Reconstructed Response instance
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

/**
 * Type guard to check if a value is a Web API object instance
 * 
 * @param value - The value to check
 * @returns true if the value is a Request, Response, Headers, or URL instance
 */
export function isWebApiObject(value: any): boolean {
  return (
    value instanceof Request ||
    value instanceof Response ||
    value instanceof Headers ||
    value instanceof URL
  );
}

