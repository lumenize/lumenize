/**
 * ResponseSync - Synchronous Response wrapper for structured-clone
 * 
 * Wraps the Web API Response object to provide synchronous body access methods.
 * Body must be provided in serializable format (string, ArrayBuffer, or plain object).
 * 
 * This enables structured-clone to be fully synchronous, which is critical for
 * Lumenize's race-free Durable Object lifecycle hooks.
 * 
 * @example
 * ```typescript
 * // Create with plain object body
 * const res = new ResponseSync(
 *   { message: 'Success', data: [1, 2, 3] },
 *   {
 *     status: 200,
 *     statusText: 'OK',
 *     headers: { 'Content-Type': 'application/json' }
 *   }
 * );
 * 
 * // Access body synchronously (no await!)
 * const data = res.json();  // { message: 'Success', data: [1, 2, 3] }
 * const text = res.text();  // '{"message":"Success","data":[1,2,3]}'
 * 
 * // Convert to real Response
 * const realResponse = res.toResponse();
 * ```
 */

/**
 * Serializable body types for ResponseSync
 */
export type SerializableBody = string | ArrayBuffer | Record<string, any> | null;

/**
 * Synchronous Response wrapper
 * 
 * Provides synchronous body access methods (.text(), .json(), .arrayBuffer())
 * by storing the body separately in serializable format.
 */
export class ResponseSync {
  /** Internal Response object (metadata only, no body stream) */
  _response: Response;
  
  /** Serializable body (string, ArrayBuffer, or plain object) */
  body: SerializableBody;
  
  /**
   * Create a ResponseSync
   * 
   * @param body - Serializable body (string, ArrayBuffer, or plain object)
   * @param init - Response options (status, headers, etc.)
   */
  constructor(body?: SerializableBody, init?: ResponseInit) {
    // Create Response without body (metadata only)
    this._response = new Response(null, init);
    
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
    throw new Error('FormData not supported in ResponseSync - use json() or text() instead');
  }
  
  // ===== Metadata Forwarders =====
  
  /** HTTP status code */
  get status(): number {
    return this._response.status;
  }
  
  /** HTTP status text */
  get statusText(): string {
    return this._response.statusText;
  }
  
  /** Response headers */
  get headers(): Headers {
    return this._response.headers;
  }
  
  /** Whether response is successful (status 200-299) */
  get ok(): boolean {
    return this._response.ok;
  }
  
  /** Whether response was redirected */
  get redirected(): boolean {
    return this._response.redirected;
  }
  
  /** Response type */
  get type(): ResponseType {
    return this._response.type;
  }
  
  /** Response URL */
  get url(): string {
    return this._response.url;
  }
  
  // ===== Utility Methods =====
  
  /**
   * Clone this ResponseSync
   * 
   * @returns New ResponseSync with same properties
   */
  clone(): ResponseSync {
    return new ResponseSync(this.body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers
    });
  }
  
  /**
   * Convert to real Response object
   * 
   * Useful for returning from fetch() handlers or other APIs that expect a real Response.
   * 
   * @returns Real Response object with body
   */
  toResponse(): Response {
    return new Response(this.body, {
      status: this.status,
      statusText: this.statusText,
      headers: this.headers
    });
  }
  
  /**
   * Create a ResponseSync from a real Response object
   * 
   * Note: This is async because it needs to read the Response body stream.
   * Use this when you have a real Response and need to convert it for serialization.
   * 
   * @param response - Real Response object
   * @returns Promise<ResponseSync>
   * 
   * @example
   * ```typescript
   * const response = await fetch('https://api.example.com/data');
   * const syncResponse = await ResponseSync.fromResponse(response);
   * // Now can serialize syncResponse with structured-clone (sync!)
   * ```
   */
  static async fromResponse(response: Response): Promise<ResponseSync> {
    // Read body once (only async operation)
    let body: SerializableBody = null;
    if (response.body && !response.bodyUsed) {
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('application/json')) {
        // Parse as JSON for convenience
        body = await response.json();
      } else if (contentType.includes('text/') || contentType.includes('application/javascript')) {
        // Store as text
        body = await response.text();
      } else {
        // Binary data - store as ArrayBuffer
        body = await response.arrayBuffer();
      }
    }
    
    return new ResponseSync(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
}

