/**
 * Marker-based Web API object serialization utilities
 * 
 * These are LOW-LEVEL utilities for when you need explicit control over Web API serialization.
 * Most users should use stringify()/parse() which handle Web API objects automatically via native serialization.
 * 
 * Use cases for marker-based approach:
 * - Storing in queues where you control serialization timing (proxy-fetch)
 * - Persisting to DO storage where you need the marker flag
 * - Manual control over when serialization happens
 * 
 * Note: Unlike native serialization which preserves full Web API instances,
 * this marker-based approach converts to plain objects with __isSerializedX flags.
 * 
 * Handles Request, Response, Headers, and URL objects that are common in Cloudflare Workers.
 */

/**
 * @internal
 * Shared helper: Read Request body, optionally cloning first to avoid consumption
 */
export async function readRequestBody(request: Request, clone: boolean = false): Promise<string | null> {
  if (!request.body || request.bodyUsed) {
    return null;
  }
  
  try {
    if (clone) {
      const cloned = request.clone();
      return await cloned.text();
    } else {
      return await request.text();
    }
  } catch (e) {
    // Body might already be consumed or not readable
    return null;
  }
}

/**
 * @internal
 * Shared helper: Read Response body, optionally cloning first to avoid consumption
 */
export async function readResponseBody(response: Response, clone: boolean = false): Promise<string | null> {
  if (!response.body || response.bodyUsed) {
    return null;
  }
  
  try {
    if (clone) {
      const cloned = response.clone();
      return await cloned.text();
    } else {
      return await response.text();
    }
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
 * @internal
 * Shared helper: Extract Request properties for serialization
 */
export function extractRequestProperties(request: Request): {
  url: string;
  method: string;
  redirect?: RequestRedirect;
  integrity?: string;
  keepalive?: boolean;
  mode?: RequestMode;
  credentials?: RequestCredentials;
  cache?: RequestCache;
  referrer?: string;
} {
  return {
    url: request.url,
    method: request.method,
    redirect: request.redirect,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    credentials: request.credentials,
    cache: request.cache,
    referrer: request.referrer,
  };
}

/**
 * @internal
 * Shared helper: Extract Response properties for serialization
 */
export function extractResponseProperties(response: Response): {
  status: number;
  statusText: string;
  ok: boolean;
  redirected: boolean;
  type: ResponseType;
  url: string;
} {
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    type: response.type,
    url: response.url,
  };
}

/**
 * Type guard to check if an object is a marker-based serialized Web API object
 * 
 * @param obj - The object to check
 * @returns true if the object has a Web API serialization marker
 */
export function isSerializedWebApiObject(obj: any): boolean {
  return obj && typeof obj === 'object' && (
    obj.__isSerializedRequest ||
    obj.__isSerializedResponse ||
    obj.__isSerializedHeaders ||
    obj.__isSerializedURL
  );
}

/**
 * Type guard to check if a value is a Web API object instance that needs serialization
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

/**
 * Serializes Web API objects (Request, Response, Headers, URL) to plain objects with marker flags
 * 
 * Preserves all important properties for proper reconstruction. AbortSignals cannot be serialized
 * and are set to `null`. 
 * 
 * Use this when you need explicit control over serialization timing (e.g., queue storage).
 * For general Web API serialization, use `stringify()` which preserves instances via native serialization.
 * 
 * @param value - Web API object to serialize
 * @param cloneBody - If true, clone Request/Response before reading body to avoid consumption. Default true.
 * @example
 * ```typescript
 * // Queue storage (e.g., proxy-fetch) - clones body to avoid consumption
 * const request = new Request('https://api.example.com', {
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'test' })
 * });
 * const serialized = await serializeWebApiObject(request, true);
 * await queue.send({ request: serialized }); // Queue message
 * 
 * // Later, in consumer:
 * const message = await queue.receive();
 * const restored = deserializeWebApiObject(message.request); // Back to Request
 * const data = await restored.json();
 * ```
 */
export async function serializeWebApiObject(value: any, cloneBody: boolean = true): Promise<any> {
  // Handle Request
  if (value instanceof Request) {
    const props = extractRequestProperties(value);
    const body = await readRequestBody(value, cloneBody);
    
    const serialized: any = {
      __isSerializedRequest: true,
      ...props,
      headers: await serializeWebApiObject(value.headers, cloneBody),
      signal: null, // AbortSignal can't be serialized
    };
    
    if (body !== null) {
      serialized.body = body;
      serialized.bodyType = 'text'; // For now, store as text
    }
    
    return serialized;
  }
  
  // Handle Response
  if (value instanceof Response) {
    const props = extractResponseProperties(value);
    const body = await readResponseBody(value, cloneBody);
    
    const serialized: any = {
      __isSerializedResponse: true,
      ...props,
      headers: await serializeWebApiObject(value.headers, cloneBody),
    };
    
    if (body !== null) {
      serialized.body = body;
      serialized.bodyType = 'text'; // For now, store as text
    }
    
    return serialized;
  }
  
  // Handle Headers
  if (value instanceof Headers) {
    return {
      __isSerializedHeaders: true,
      entries: headersToArray(value),
    };
  }
  
  // Handle URL
  if (value instanceof URL) {
    return {
      __isSerializedURL: true,
      href: value.href,
    };
  }
  
  // Not a Web API object, return as-is
  return value;
}

/**
 * Deserializes marker-based Web API objects back to proper instances
 * 
 * Reconstructs Request, Response, Headers, and URL instances from the plain
 * objects created by serializeWebApiObject().
 * 
 * Note: This is for explicit deserialization control (e.g., proxy-fetch queues).
 * For general Web API deserialization, use parse() which handles them via native serialization.
 */
export function deserializeWebApiObject(value: any): any {
  if (!value || typeof value !== 'object') {
    return value;
  }
  
  // Reconstruct Request
  if (value.__isSerializedRequest) {
    const init: RequestInit = {
      method: value.method,
      headers: deserializeWebApiObject(value.headers),
      redirect: value.redirect,
      integrity: value.integrity,
      keepalive: value.keepalive,
      mode: value.mode,
      credentials: value.credentials,
      cache: value.cache,
      referrer: value.referrer,
    };
    
    // Add body if present (only for methods that support it)
    if (value.body !== null && value.body !== undefined && value.method !== 'GET' && value.method !== 'HEAD') {
      init.body = value.body;
    }
    
    return new Request(value.url, init);
  }
  
  // Reconstruct Response
  if (value.__isSerializedResponse) {
    const init: ResponseInit = {
      status: value.status,
      statusText: value.statusText,
      headers: deserializeWebApiObject(value.headers),
    };
    
    // 204 No Content and 205 Reset Content cannot have a body
    // 304 Not Modified also cannot have a body
    const cannotHaveBody = value.status === 204 || value.status === 205 || value.status === 304;
    const body = (cannotHaveBody || value.body === null || value.body === undefined) ? null : value.body;
    
    return new Response(body, init);
  }
  
  // Reconstruct Headers
  if (value.__isSerializedHeaders) {
    return new Headers(value.entries);
  }
  
  // Reconstruct URL
  if (value.__isSerializedURL) {
    return new URL(value.href);
  }
  
  // Not a serialized Web API object, return as-is
  return value;
}

