/**
 * Serialization utilities for Web API objects over RPC
 * 
 * Handles Request, Response, Headers, and URL objects that can't be directly
 * serialized by @ungap/structured-clone. Similar to error-serialization.ts,
 * we convert these to plain objects with markers and reconstruct them on the
 * client side.
 */

/**
 * Serializes Web API objects (Request, Response, Headers, URL) for transmission
 * 
 * @ungap/structured-clone partially handles Request/Response but loses prototypes
 * and doesn't handle Headers or URL properly. This function explicitly converts
 * them to plain objects with markers for proper reconstruction.
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
 * 
 * Reconstructs Request, Response, Headers, and URL instances from the plain
 * objects created by serializeWebApiObject.
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
