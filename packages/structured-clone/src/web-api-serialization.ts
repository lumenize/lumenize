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
 * and are set to `null`. Request/Response bodies are cloned before reading to avoid consumption.
 * 
 * Use this when you need explicit control over serialization timing (e.g., queue storage).
 * For general Web API serialization, use `stringify()` which preserves instances via native serialization.
 * 
 * @example
 * ```typescript
 * // Queue storage (e.g., proxy-fetch)
 * const request = new Request('https://api.example.com', {
 *   method: 'POST',
 *   body: JSON.stringify({ data: 'test' })
 * });
 * const serialized = await serializeWebApiObject(request);
 * await queue.send({ request: serialized }); // Queue message
 * 
 * // Later, in consumer:
 * const message = await queue.receive();
 * const restored = deserializeWebApiObject(message.request); // Back to Request
 * const data = await restored.json();
 * ```
 */
export async function serializeWebApiObject(value: any): Promise<any> {
  // Handle Request
  if (value instanceof Request) {
    const serialized: any = {
      __isSerializedRequest: true,
      method: value.method,
      url: value.url,
      headers: await serializeWebApiObject(value.headers),
      redirect: value.redirect,
      integrity: value.integrity,
      keepalive: value.keepalive,
      signal: null, // AbortSignal can't be serialized
    };
    
    // Clone and read body if present and not yet consumed
    if (value.body && !value.bodyUsed) {
      const cloned = value.clone();
      const bodyText = await cloned.text();
      serialized.body = bodyText;
      serialized.bodyType = 'text'; // For now, store as text
    }
    
    return serialized;
  }
  
  // Handle Response
  if (value instanceof Response) {
    const serialized: any = {
      __isSerializedResponse: true,
      status: value.status,
      statusText: value.statusText,
      headers: await serializeWebApiObject(value.headers),
      ok: value.ok,
      redirected: value.redirected,
      type: value.type,
      url: value.url,
    };
    
    // Clone and read body if present and not yet consumed
    if (value.body && !value.bodyUsed) {
      const cloned = value.clone();
      const bodyText = await cloned.text();
      serialized.body = bodyText;
      serialized.bodyType = 'text'; // For now, store as text
    }
    
    return serialized;
  }
  
  // Handle Headers
  if (value instanceof Headers) {
    const serialized: any = {
      __isSerializedHeaders: true,
      entries: [] as [string, string][],
    };
    
    // Convert headers to array of [key, value] pairs
    // Headers is iterable in Workers
    value.forEach((val, key) => {
      serialized.entries.push([key, val]);
    });
    
    return serialized;
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
    };
    
    // Add body if present
    if (value.body) {
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
    
    // Create Response with body if present
    const body = value.body || null;
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

