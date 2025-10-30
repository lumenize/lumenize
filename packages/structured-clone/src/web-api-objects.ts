/**
 * Web API object serialization for Request, Response, Headers, URL
 * These objects are common in Cloudflare Workers and need special handling
 */

/**
 * Marker types for Web API objects
 */
export interface RequestMarker {
  __lmz_Request: true;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  mode?: RequestMode;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrer?: string;
  integrity?: string;
}

export interface ResponseMarker {
  __lmz_Response: true;
  body: string | null;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

export interface HeadersMarker {
  __lmz_Headers: true;
  entries: Record<string, string>;
}

export interface URLMarker {
  __lmz_URL: true;
  href: string;
}

export type WebApiMarker = RequestMarker | ResponseMarker | HeadersMarker | URLMarker;

/**
 * Check if a value is a Web API object that needs serialization
 */
export function isWebApiObject(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  
  // Check constructor names (works in both Node.js and Workers)
  const constructorName = value.constructor?.name;
  return (
    constructorName === 'Request' ||
    constructorName === 'Response' ||
    constructorName === 'Headers' ||
    constructorName === 'URL'
  );
}

/**
 * Get the type of Web API object
 */
export function getWebApiType(value: any): 'Request' | 'Response' | 'Headers' | 'URL' | null {
  if (!value || typeof value !== 'object') return null;
  
  const constructorName = value.constructor?.name;
  if (constructorName === 'Request') return 'Request';
  if (constructorName === 'Response') return 'Response';
  if (constructorName === 'Headers') return 'Headers';
  if (constructorName === 'URL') return 'URL';
  
  return null;
}

/**
 * Serialize a Request object
 * Note: This consumes the body stream
 */
export async function serializeRequest(request: Request): Promise<RequestMarker> {
  // Read body if present (this consumes the stream)
  let body: string | null = null;
  try {
    body = await request.text();
  } catch (e) {
    // Body might already be consumed or not readable
    body = null;
  }
  
  // Convert Headers to plain object
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  return {
    __lmz_Request: true,
    url: request.url,
    method: request.method,
    headers,
    body,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    redirect: request.redirect,
    referrer: request.referrer,
    integrity: request.integrity
  };
}

/**
 * Deserialize a Request marker back to Request object
 */
export function deserializeRequest(marker: RequestMarker): Request {
  const { url, method, headers, body, mode, credentials, cache, redirect, referrer, integrity } = marker;
  
  const init: RequestInit = {
    method,
    headers,
    mode,
    credentials,
    cache,
    redirect,
    referrer,
    integrity
  };
  
  // Add body if present (only for methods that support it)
  if (body !== null && method !== 'GET' && method !== 'HEAD') {
    init.body = body;
  }
  
  return new Request(url, init);
}

/**
 * Serialize a Response object
 * Note: This consumes the body stream
 */
export async function serializeResponse(response: Response): Promise<ResponseMarker> {
  // Read body if present (this consumes the stream)
  let body: string | null = null;
  try {
    body = await response.text();
  } catch (e) {
    // Body might already be consumed or not readable
    body = null;
  }
  
  // Convert Headers to plain object
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  
  return {
    __lmz_Response: true,
    body,
    status: response.status,
    statusText: response.statusText,
    headers
  };
}

/**
 * Deserialize a Response marker back to Response object
 */
export function deserializeResponse(marker: ResponseMarker): Response {
  const { body, status, statusText, headers } = marker;
  
  // 204 No Content and 205 Reset Content cannot have a body
  // 304 Not Modified also cannot have a body
  const cannotHaveBody = status === 204 || status === 205 || status === 304;
  
  return new Response(cannotHaveBody ? null : body, {
    status,
    statusText,
    headers
  });
}

/**
 * Serialize Headers object
 */
export function serializeHeaders(headers: Headers): HeadersMarker {
  const entries: Record<string, string> = {};
  headers.forEach((value, key) => {
    entries[key] = value;
  });
  
  return {
    __lmz_Headers: true,
    entries
  };
}

/**
 * Deserialize Headers marker back to Headers object
 */
export function deserializeHeaders(marker: HeadersMarker): Headers {
  return new Headers(marker.entries);
}

/**
 * Serialize URL object
 */
export function serializeURL(url: URL): URLMarker {
  return {
    __lmz_URL: true,
    href: url.href
  };
}

/**
 * Deserialize URL marker back to URL object
 */
export function deserializeURL(marker: URLMarker): URL {
  return new URL(marker.href);
}

/**
 * Check if a value is a serialized Web API marker
 */
export function isSerializedWebApiObject(value: any): value is WebApiMarker {
  return value && typeof value === 'object' && (
    value.__lmz_Request === true ||
    value.__lmz_Response === true ||
    value.__lmz_Headers === true ||
    value.__lmz_URL === true
  );
}

/**
 * Deserialize any Web API marker back to its object
 */
export function deserializeWebApiObject(marker: WebApiMarker): Request | Response | Headers | URL {
  if ('__lmz_Request' in marker) {
    return deserializeRequest(marker);
  }
  if ('__lmz_Response' in marker) {
    return deserializeResponse(marker);
  }
  if ('__lmz_Headers' in marker) {
    return deserializeHeaders(marker);
  }
  if ('__lmz_URL' in marker) {
    return deserializeURL(marker);
  }
  throw new Error('Unknown Web API marker type');
}

