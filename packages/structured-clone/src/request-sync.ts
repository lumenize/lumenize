/**
 * RequestSync - Synchronous Request wrapper for structured-clone
 * 
 * Wraps the Web API Request object to provide synchronous body access methods.
 * User must provide body in serializable format (string, ArrayBuffer, or plain object).
 * 
 * This enables structured-clone to be fully synchronous, which is critical for
 * Lumenize's race-free Durable Object lifecycle hooks.
 * 
 * @example
 * ```typescript
 * // Create with plain object body
 * const req = new RequestSync('https://api.example.com/users', {
 *   method: 'POST',
 *   body: { name: 'Alice', age: 30 },
 *   headers: { 'Content-Type': 'application/json' }
 * });
 * 
 * // Access body synchronously (no await!)
 * const data = req.json();  // { name: 'Alice', age: 30 }
 * const text = req.text();  // '{"name":"Alice","age":30}'
 * 
 * // Convert to real Request for fetch
 * const realRequest = req.toRequest();
 * const response = await fetch(realRequest);
 * ```
 */

/**
 * Serializable body types for RequestSync
 * @internal
 */
export type SerializableBody = string | ArrayBuffer | Record<string, any> | null;

/**
 * Extended RequestInit that accepts serializable body
 * @internal
 */
export interface RequestSyncInit extends Omit<RequestInit, 'body'> {
  body?: SerializableBody;
}

/**
 * Synchronous Request wrapper
 * 
 * Provides synchronous body access methods (.text(), .json(), .arrayBuffer())
 * by storing the body separately in serializable format.
 */
export class RequestSync {
  /** Internal Request object (metadata only, no body stream) */
  _request: Request;
  
  /** Serializable body (string, ArrayBuffer, or plain object) */
  body: SerializableBody;
  
  /**
   * Create a RequestSync
   * 
   * @param input - URL or Request object
   * @param init - Request options with serializable body
   */
  constructor(input: RequestInfo | URL, init?: RequestSyncInit) {
    // Extract body and create Request without it (metadata only)
    const { body, ...requestInit } = init || {};
    this._request = new Request(input, requestInit);
    
    // Store body separately in serializable format
    this.body = body ?? null;
  }
  
  // ===== Synchronous Body Readers =====
  
  /**
   * Get body as parsed JSON (synchronous)
   * 
   * @returns Parsed JSON object or null if no body
   */
  json(): any {
    if (typeof this.body === 'string') {
      return JSON.parse(this.body);
    }
    if (this.body instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(this.body));
    }
    if (typeof this.body === 'object' && this.body !== null) {
      return this.body;
    }
    return null;
  }
  
  /**
   * Get body as text string (synchronous)
   * 
   * @returns Text representation of body
   */
  text(): string {
    if (typeof this.body === 'string') {
      return this.body;
    }
    if (this.body instanceof ArrayBuffer) {
      return new TextDecoder().decode(this.body);
    }
    if (typeof this.body === 'object' && this.body !== null) {
      return JSON.stringify(this.body);
    }
    return '';
  }
  
  /**
   * Get body as ArrayBuffer (synchronous)
   * 
   * @returns ArrayBuffer representation of body
   */
  arrayBuffer(): ArrayBuffer {
    if (this.body instanceof ArrayBuffer) {
      return this.body;
    }
    if (typeof this.body === 'string') {
      return new TextEncoder().encode(this.body).buffer;
    }
    if (typeof this.body === 'object' && this.body !== null) {
      return new TextEncoder().encode(JSON.stringify(this.body)).buffer;
    }
    return new ArrayBuffer(0);
  }
  
  /**
   * Get body as Blob (synchronous)
   * 
   * @returns Blob containing body data
   */
  blob(): Blob {
    return new Blob([this.arrayBuffer()]);
  }
  
  /**
   * FormData not supported in sync mode
   * 
   * @throws {Error} Always throws - use json() or text() instead
   */
  formData(): never {
    throw new Error('FormData not supported in RequestSync - use json() or text() instead');
  }
  
  // ===== Metadata Forwarders =====
  
  /** Request URL */
  get url(): string {
    return this._request.url;
  }
  
  /** HTTP method */
  get method(): string {
    return this._request.method;
  }
  
  /** Request headers */
  get headers(): Headers {
    return this._request.headers;
  }
  
  /** Abort signal */
  get signal(): AbortSignal {
    return this._request.signal;
  }
  
  /** Credentials mode */
  get credentials(): RequestCredentials {
    return this._request.credentials;
  }
  
  /** Referrer URL */
  get referrer(): string {
    return this._request.referrer;
  }
  
  /** Referrer policy */
  get referrerPolicy(): ReferrerPolicy {
    return this._request.referrerPolicy;
  }
  
  /** Request mode */
  get mode(): RequestMode {
    return this._request.mode;
  }
  
  /** Cache mode */
  get cache(): RequestCache {
    return this._request.cache;
  }
  
  /** Redirect mode */
  get redirect(): RequestRedirect {
    return this._request.redirect;
  }
  
  /** Subresource integrity */
  get integrity(): string {
    return this._request.integrity;
  }
  
  /** Keep-alive flag */
  get keepalive(): boolean {
    return this._request.keepalive;
  }
  
  /** Request destination */
  get destination(): RequestDestination {
    return this._request.destination;
  }
  
  // ===== Utility Methods =====
  
  /**
   * Clone this RequestSync
   * 
   * @returns New RequestSync with same properties
   */
  clone(): RequestSync {
    return new RequestSync(this._request.url, {
      method: this.method,
      headers: this.headers,
      body: this.body,
      credentials: this.credentials,
      mode: this.mode,
      cache: this.cache,
      redirect: this.redirect,
      referrer: this.referrer,
      referrerPolicy: this.referrerPolicy,
      integrity: this.integrity,
      keepalive: this.keepalive,
      signal: this.signal
    });
  }
  
  /**
   * Convert to real Request object
   * 
   * Useful for passing to fetch() or other APIs that expect a real Request.
   * 
   * @returns Real Request object with body
   */
  toRequest(): Request {
    // Convert plain object bodies to JSON string for Request constructor
    const bodyInit = (this.body && typeof this.body === 'object' && !(this.body instanceof ArrayBuffer))
      ? JSON.stringify(this.body)
      : this.body as BodyInit | null;
    
    return new Request(this._request.url, {
      method: this.method,
      headers: this.headers,
      body: bodyInit,
      credentials: this.credentials,
      mode: this.mode,
      cache: this.cache,
      redirect: this.redirect,
      referrer: this.referrer,
      referrerPolicy: this.referrerPolicy,
      integrity: this.integrity,
      keepalive: this.keepalive,
      signal: this.signal
    });
  }
}

