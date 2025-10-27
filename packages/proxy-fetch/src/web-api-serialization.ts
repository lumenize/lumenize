/**
 * Serialization utilities for Web API objects over RPC
 * 
 * Handles Request, Response, Headers, and URL objects that can't be directly
 * serialized by structured clone. We convert these to plain objects with 
 * markers and reconstruct them on the other side.
 * 
 * Copied from @lumenize/rpc/src/web-api-serialization.ts
 */

/**
 * Type guard to check if an object is a serialized Web API object
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
 * Serializes Web API objects (Request, Response, Headers, URL) for transmission
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
 * Deserializes Web API objects back to proper instances
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
