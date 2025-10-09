// Test setup for utils package
// Polyfills for DOM events not available in Node environment

class MockErrorEvent extends Event {
  error?: any;
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;

  constructor(type: string, options?: { error?: any; message?: string; filename?: string; lineno?: number; colno?: number }) {
    super(type);
    this.error = options?.error;
    this.message = options?.message || '';
    this.filename = options?.filename;
    this.lineno = options?.lineno;
    this.colno = options?.colno;
  }
}

class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;

  constructor(type: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(type);
    this.code = options?.code || 1000;
    this.reason = options?.reason || '';
    this.wasClean = options?.wasClean !== undefined ? options.wasClean : true;
  }
}

// Make these available globally for websocket-shim
globalThis.ErrorEvent = MockErrorEvent as any;
globalThis.CloseEvent = MockCloseEvent as any;
