/**
 * Format verbosity and performance experiments
 * 
 * Compares current indexed format vs alternative formats
 */

import { stringify, parse } from '../src/index.js';

// ============================================================================
// Test Data Structures
// ============================================================================

/**
 * Simple object with no cycles/aliases
 */
function createSimpleObject() {
  return {
    name: 'John',
    age: 30,
    tags: ['developer', 'javascript'],
    metadata: {
      created: new Date('2024-01-01'),
      active: true
    }
  };
}

/**
 * Object with self-reference (cycle)
 */
function createCyclicObject() {
  const obj: any = {
    id: 1,
    name: 'Root',
    children: []
  };
  obj.self = obj; // Self-reference
  obj.children.push(obj); // Also in array
  return obj;
}

/**
 * Object with aliases (same object via different paths)
 */
function createAliasedObject() {
  const shared = {
    id: 999,
    data: 'shared-value'
  };
  
  return {
    a: { ref: shared },
    b: { ref: shared },
    c: shared, // Direct reference
    list: [shared, shared] // Multiple times in array
  };
}

/**
 * Deep nested structure
 */
function createDeepNested(depth: number = 50) {
  let current: any = { value: 'deep' };
  for (let i = 0; i < depth; i++) {
    current = { level: i, nested: current };
  }
  return current;
}

/**
 * Large shared subtree (alias scenario)
 */
function createLargeSharedSubtree() {
  const shared = {
    config: {
      theme: 'dark',
      language: 'en',
      settings: {
        notifications: true,
        sound: false
      }
    },
    metadata: {
      version: '1.0.0',
      timestamp: new Date()
    }
  };
  
  return {
    user1: {
      profile: shared,
      preferences: shared.config
    },
    user2: {
      profile: shared,
      preferences: shared.config
    },
    system: {
      defaultConfig: shared.config
    }
  };
}

/**
 * Complex structure with Map, Set, RegExp
 */
function createComplexStructure() {
  const map = new Map([
    ['key1', 'value1'],
    ['key2', { nested: 'data' }]
  ]);
  
  const set = new Set(['a', 'b', 'c']);
  
  return {
    map,
    set,
    regex: /^test-\d+$/gi,
    date: new Date('2024-01-01'),
    buffer: new ArrayBuffer(8)
  };
}

/**
 * Structure with Error objects (verbose markers impact size)
 */
function createErrorStructure() {
  const error1 = new Error('First error');
  error1.stack = 'Error: First error\n    at createErrorStructure (test.js:1:1)\n    at <anonymous>';
  error1.code = 'ERR_FIRST';
  error1.statusCode = 404;
  
  const error2 = new TypeError('Type error occurred');
  error2.stack = 'TypeError: Type error occurred\n    at processData (data.js:10:5)';
  error2.cause = error1; // Nested error
  
  return {
    operation: 'fetch',
    errors: [error1, error2],
    metadata: {
      timestamp: new Date(),
      source: 'api-client'
    }
  };
}

/**
 * Structure with Web API types (Request, Response, URL, Headers)
 * These have verbose __isSerializedX markers that impact payload size
 */
function createWebApiStructure() {
  const url = new URL('https://api.example.com/v1/users?page=1&limit=10');
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': 'Bearer token123',
    'X-Request-ID': 'req-456'
  });
  
  // Note: Request/Response require async body reading, so we'll just test URL/Headers
  // For full Request/Response testing, we'd need to handle async serialization
  return {
    endpoint: url,
    headers: headers,
    config: {
      timeout: 5000,
      retries: 3,
      baseUrl: new URL('https://api.example.com')
    },
    metadata: {
      createdAt: new Date(),
      version: 'v1'
    }
  };
}

// ============================================================================
// Benchmarking Utilities
// ============================================================================

interface BenchmarkResult {
  sizeMinified: number;
  sizePretty: number;
  charCount: number;
  serializeTime: number;
  parseTime: number;
  format: string;
}

async function benchmarkFormat(
  name: string,
  data: any,
  serializeFn: (data: any) => Promise<string>,
  parseFn: (json: string) => Promise<any>
): Promise<BenchmarkResult> {
  // Serialize and measure
  const serializeStart = performance.now();
  const jsonMin = await serializeFn(data);
  const serializeEnd = performance.now();
  
  const serializeTime = serializeEnd - serializeStart;
  const sizeMinified = new TextEncoder().encode(jsonMin).length;
  const charCount = jsonMin.length;
  
  // Pretty-print and measure
  const parsed = JSON.parse(jsonMin);
  const jsonPretty = JSON.stringify(parsed, null, 2);
  const sizePretty = new TextEncoder().encode(jsonPretty).length;
  
  // Parse and measure
  const parseStart = performance.now();
  const restored = await parseFn(jsonMin);
  const parseEnd = performance.now();
  const parseTime = parseEnd - parseStart;
  
  // Verify round-trip (basic check - deep equality would be better)
  if (typeof data === 'object' && data !== null) {
    // Basic verification - in real test we'd do deep equality
  }
  
  return {
    sizeMinified,
    sizePretty,
    charCount,
    serializeTime,
    parseTime,
    format: name
  };
}

// ============================================================================
// Format Implementations
// ============================================================================

/**
 * Current indexed format (structured-clone)
 */
async function serializeCurrentFormat(data: any): Promise<string> {
  return await stringify(data);
}

async function parseCurrentFormat(json: string): Promise<any> {
  return parse(json);
}

/**
 * $ref-like format using __ref markers (similar to JSON Schema $ref)
 * Uses inline values with reference markers for cycles/aliases
 */
async function serializeRefStyle(data: any): Promise<string> {
  const seen = new WeakMap<any, string>();
  const objects = new Map<string, any>();
  let nextId = 0;
  
  function serializeValue(value: any): any {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (typeof value === 'object') {
      // Check for cycles/aliases
      if (seen.has(value)) {
        return { __ref: seen.get(value)! };
      }
      
      // Assign ID
      const id = `#${nextId++}`;
      seen.set(value, id);
      
      // Serialize based on type
      let serialized: any;
      
      if (Array.isArray(value)) {
        serialized = value.map(item => serializeValue(item));
      } else if (value instanceof Map) {
        const entries: any[] = [];
        for (const [key, val] of value) {
          entries.push([serializeValue(key), serializeValue(val)]);
        }
        serialized = { type: 'map', entries };
      } else if (value instanceof Set) {
        const values: any[] = [];
        for (const item of value) {
          values.push(serializeValue(item));
        }
        serialized = { type: 'set', values };
      } else if (value instanceof Date) {
        serialized = { type: 'date', iso: value.toISOString() };
      } else if (value instanceof RegExp) {
        serialized = { type: 'regexp', source: value.source, flags: value.flags };
      } else if (value instanceof Error) {
        // Error object - preserve name, message, stack, cause, custom properties
        serialized = {
          type: 'error',
          name: value.name || 'Error',
          message: value.message || ''
        };
        if (value.stack) serialized.stack = value.stack;
        if (value.cause !== undefined) serialized.cause = serializeValue(value.cause);
        // Custom properties
        const customProps: any = {};
        const allProps = Object.getOwnPropertyNames(value);
        for (const key of allProps) {
          if (!['name', 'message', 'stack', 'cause'].includes(key)) {
            try {
              customProps[key] = serializeValue((value as any)[key]);
            } catch {}
          }
        }
        if (Object.keys(customProps).length > 0) {
          serialized.customProps = customProps;
        }
      } else if (value instanceof URL) {
        serialized = { type: 'url', href: value.href };
      } else if (value instanceof Headers) {
        const entries: [string, string][] = [];
        value.forEach((val, key) => {
          entries.push([key, val]);
        });
        serialized = { type: 'headers', entries };
      } else if (value instanceof ArrayBuffer) {
        // Convert ArrayBuffer to base64
        const bytes = new Uint8Array(value);
        const base64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
        serialized = { type: 'arraybuffer', base64 };
      } else {
        // Plain object
        serialized = {};
        for (const key in value) {
          serialized[key] = serializeValue(value[key]);
        }
      }
      
      // Store serialized value
      objects.set(id, serialized);
      return { __ref: id };
    }
    
    // Primitive
    return value;
  }
  
  const root = serializeValue(data);
  const result = {
    root,
    objects: Array.from(objects.entries()).map(([id, value]) => ({ id, ...value }))
  };
  
  return JSON.stringify(result);
}

async function parseRefStyle(json: string): Promise<any> {
  const data = JSON.parse(json);
  const objects = new Map<string, any>();
  
  // First pass: deserialize all objects into placeholders
  for (const obj of data.objects) {
    const { id, ...value } = obj;
    let deserialized: any;
    
    if (value.type === 'map') {
      deserialized = new Map();
      objects.set(id, deserialized);
      // Will fill entries in second pass
    } else if (value.type === 'set') {
      deserialized = new Set();
      objects.set(id, deserialized);
      // Will fill values in second pass
    } else if (value.type === 'date') {
      deserialized = new Date(value.iso);
      objects.set(id, deserialized);
    } else if (value.type === 'regexp') {
      deserialized = new RegExp(value.source, value.flags);
      objects.set(id, deserialized);
    } else if (value.type === 'error') {
      const ErrorClass = value.name === 'TypeError' ? TypeError :
                        value.name === 'RangeError' ? RangeError :
                        value.name === 'ReferenceError' ? ReferenceError :
                        Error;
      deserialized = new ErrorClass(value.message);
      if (value.stack) deserialized.stack = value.stack;
      objects.set(id, deserialized);
    } else if (value.type === 'url') {
      deserialized = new URL(value.href);
      objects.set(id, deserialized);
    } else if (value.type === 'headers') {
      deserialized = new Headers(value.entries);
      objects.set(id, deserialized);
    } else if (value.type === 'arraybuffer') {
      // Convert base64 back to ArrayBuffer
      const binary = atob(value.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      deserialized = bytes.buffer;
      objects.set(id, deserialized);
    } else if (Array.isArray(value)) {
      deserialized = [];
      objects.set(id, deserialized);
      // Will fill items in second pass
    } else {
      deserialized = {};
      objects.set(id, deserialized);
      // Will fill properties in second pass
    }
  }
  
  // Second pass: resolve references and fill structures
  for (const obj of data.objects) {
    const { id, ...value } = obj;
    const deserialized = objects.get(id)!;
    
    if (value.type === 'map') {
      for (const [key, val] of value.entries) {
        deserialized.set(
          resolveRef(key, objects),
          resolveRef(val, objects)
        );
      }
    } else if (value.type === 'set') {
      for (const item of value.values) {
        deserialized.add(resolveRef(item, objects));
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        deserialized[i] = resolveRef(value[i], objects);
      }
    } else if (value.type === 'error') {
      // Error already created in first pass, but need to set cause and customProps
      if (value.cause !== undefined) {
        (deserialized as Error).cause = resolveRef(value.cause, objects);
      }
      if (value.customProps) {
        for (const key in value.customProps) {
          (deserialized as any)[key] = resolveRef(value.customProps[key], objects);
        }
      }
    } else if (!value.type) {
      // Plain object
      for (const key in value) {
        deserialized[key] = resolveRef(value[key], objects);
      }
    }
    // date, regexp, url, headers, arraybuffer already fully deserialized in first pass
  }
  
  // Third pass: resolve root
  return resolveRef(data.root, objects);
}

function resolveRef(value: any, objects: Map<string, any>): any {
  if (value && typeof value === 'object' && value.__ref) {
    return objects.get(value.__ref);
  }
  if (Array.isArray(value)) {
    return value.map(item => resolveRef(item, objects));
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
    const result: any = {};
    for (const key in value) {
      result[key] = resolveRef(value[key], objects);
    }
    return result;
  }
  return value;
}

/**
 * Tuple-based $lmz format (Cap'n Web style + cycles/aliases)
 * Format: ["type", data] for values, ["$lmz", "ref"] for references
 * Combines Cap'n Web's compact tuples with cycle/alias support
 */
async function serializeTupleStyle(data: any): Promise<string> {
  const seen = new WeakMap<any, number>();
  const objects: any[] = [];
  let nextId = 0;
  
  function serializeValue(value: any): any {
    // Primitives
    if (value === null) return ["null"];
    if (value === undefined) return ["undefined"];
    if (typeof value === 'string') return ["string", value];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ["number", "NaN"];
      if (value === Infinity) return ["number", "Infinity"];
      if (value === -Infinity) return ["number", "-Infinity"];
      return ["number", value];
    }
    if (typeof value === 'boolean') return ["boolean", value];
    if (typeof value === 'bigint') return ["bigint", value.toString()];
    
    // Objects - check for cycles/aliases
    if (typeof value === 'object') {
      // Check for cycles/aliases
      if (seen.has(value)) {
        return ["$lmz", seen.get(value)!];
      }
      
      // Assign ID and track
      const id = nextId++;
      seen.set(value, id);
      
      // Serialize based on type
      if (Array.isArray(value)) {
        const items = value.map(item => serializeValue(item));
        const tuple: any = ["array", items];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Map) {
        const entries: any[] = [];
        for (const [key, val] of value) {
          entries.push([serializeValue(key), serializeValue(val)]);
        }
        const tuple: any = ["map", entries];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Set) {
        const values: any[] = [];
        for (const item of value) {
          values.push(serializeValue(item));
        }
        const tuple: any = ["set", values];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (value instanceof Date) {
        return ["date", value.toISOString()];
      } else if (value instanceof RegExp) {
        return ["regexp", { source: value.source, flags: value.flags }];
      } else if (value instanceof Error) {
        // Error object - preserve name, message, stack, cause, custom properties
        const errorData: any = {
          name: value.name || 'Error',
          message: value.message || ''
        };
        if (value.stack) errorData.stack = value.stack;
        if (value.cause !== undefined) errorData.cause = serializeValue(value.cause);
        
        // Custom properties
        const allProps = Object.getOwnPropertyNames(value);
        for (const key of allProps) {
          if (!['name', 'message', 'stack', 'cause'].includes(key)) {
            try {
              errorData[key] = serializeValue((value as any)[key]);
            } catch {}
          }
        }
        
        const tuple: any = ["error", errorData];
        objects[id] = tuple;
        return ["$lmz", id];
      } else if (typeof (value as any).constructor === 'function') {
        // Check for Web API types
        const constructorName = value.constructor.name;
        if (constructorName === 'URL') {
          return ["url", { href: value.href }];
        } else if (constructorName === 'Headers') {
          const entries: [string, string][] = [];
          (value as Headers).forEach((val: string, key: string) => {
            entries.push([key, val]);
          });
          return ["headers", entries];
        } else if (constructorName.includes('Array') && value.buffer) {
          // TypedArray
          const arr = Array.from(value as any);
          return ["arraybuffer", arr];
        }
      }
      
      // Plain object
      const obj: any = {};
      for (const key in value) {
        obj[key] = serializeValue(value[key]);
      }
      const tuple: any = ["object", obj];
      objects[id] = tuple;
      return ["$lmz", id];
    }
    
    return value;
  }
  
  const root = serializeValue(data);
  return JSON.stringify({ root, objects });
}

async function parseTupleStyle(json: string): Promise<any> {
  const data = JSON.parse(json);
  const objects = new Map<number, any>();
  
  // First pass: create all objects
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      
      const [type, value] = tuple;
      
      if (type === 'array') {
        objects.set(i, []);
      } else if (type === 'map') {
        objects.set(i, new Map());
      } else if (type === 'set') {
        objects.set(i, new Set());
      } else if (type === 'error') {
        const ErrorConstructor = (globalThis as any)[value.name] || Error;
        const error = new ErrorConstructor(value.message || '');
        error.name = value.name;
        if (value.stack !== undefined) {
          error.stack = value.stack;
        } else {
          delete error.stack;
        }
        objects.set(i, error);
      } else if (type === 'object') {
        objects.set(i, {});
      }
    }
  }
  
  // Second pass: fill structures
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      
      const [type, value] = tuple;
      const obj = objects.get(i)!;
      
      if (type === 'array') {
        for (const item of value) {
          obj.push(resolveValue(item, objects));
        }
      } else if (type === 'map') {
        for (const [key, val] of value) {
          obj.set(
            resolveValue(key, objects),
            resolveValue(val, objects)
          );
        }
      } else if (type === 'set') {
        for (const item of value) {
          obj.add(resolveValue(item, objects));
        }
      } else if (type === 'error') {
        // Error already created, fill cause and custom props
        if (value.cause !== undefined) {
          obj.cause = resolveValue(value.cause, objects);
        }
        for (const key in value) {
          if (!['name', 'message', 'stack', 'cause'].includes(key)) {
            obj[key] = resolveValue(value[key], objects);
          }
        }
      } else if (type === 'object') {
        for (const key in value) {
          obj[key] = resolveValue(value[key], objects);
        }
      }
    }
  }
  
  // Resolve root
  return resolveValue(data.root, objects);
}

function resolveValue(value: any, objects: Map<number, any>): any {
  if (!value || !Array.isArray(value)) return value;
  
  const [type, data] = value;
  
  // Reference
  if (type === '$lmz') {
    return objects.get(data);
  }
  
  // Direct value
  if (type === 'null') return null;
  if (type === 'undefined') return undefined;
  if (type === 'string') return data;
  if (type === 'number') {
    if (data === 'NaN') return NaN;
    if (data === 'Infinity') return Infinity;
    if (data === '-Infinity') return -Infinity;
    return data;
  }
  if (type === 'boolean') return data;
  if (type === 'bigint') return BigInt(data);
  if (type === 'date') return new Date(data);
  if (type === 'regexp') return new RegExp(data.source, data.flags);
  if (type === 'url') return new URL(data.href);
  if (type === 'headers') return new Headers(data);
  if (type === 'arraybuffer') return new Uint8Array(data);
  
  // Nested values (shouldn't reach here in normal flow)
  return value;
}

/**
 * Cap'n Web style format (no cycles - will fail on cycles/aliases)
 * Simplified version that demonstrates inline format
 * Note: This doesn't handle all special types properly - it's just for size comparison
 */
function serializeCapnWebStyle(data: any): string {
  // This is a simplified version for size comparison only
  // Real Cap'n Web handles Date, RegExp, Map, Set, etc. with type markers
  // For this experiment, we just want to show inline vs indexed size difference
  try {
    return JSON.stringify(data);
  } catch (e) {
    // Cycle detected - return error marker
    return '{"__error": "Cannot serialize: contains cycles"}';
  }
}

function parseCapnWebStyle(json: string): any {
  const parsed = JSON.parse(json);
  if (parsed.__error) {
    throw new Error(parsed.__error);
  }
  return parsed;
}

// ============================================================================
// Tests
// ============================================================================

describe('Format Comparison Experiments', () => {
  it('Simple object (no cycles/aliases)', async () => {
    const data = createSimpleObject();
    
    const current = await benchmarkFormat(
      'Current (indexed)',
      data,
      serializeCurrentFormat,
      parseCurrentFormat
    );
    
    const refStyle = await benchmarkFormat(
      'Object $lmz',
      data,
      serializeRefStyle,
      parseRefStyle
    );
    
    const tupleStyle = await benchmarkFormat(
      'Tuple $lmz',
      data,
      serializeTupleStyle,
      parseTupleStyle
    );
    
    const currentJson = await serializeCurrentFormat(data);
    const refJson = await serializeRefStyle(data);
    const tupleJson = await serializeTupleStyle(data);
    
    console.log('\n=== Simple Object (No Cycles/Aliases) ===');
    console.log(`\n📊 Current (indexed) format:`);
    console.log(`  Size: ${current.sizeMinified} bytes`);
    console.log(`  Serialize: ${current.serializeTime.toFixed(3)}ms, Parse: ${current.parseTime.toFixed(3)}ms`);
    console.log(`  Format: ${currentJson.substring(0, 100)}...`);
    
    console.log(`\n📊 Object $lmz format:`);
    console.log(`  Size: ${refStyle.sizeMinified} bytes (${((refStyle.sizeMinified - current.sizeMinified) / current.sizeMinified * 100).toFixed(1)}% vs indexed)`);
    console.log(`  Serialize: ${refStyle.serializeTime.toFixed(3)}ms, Parse: ${refStyle.parseTime.toFixed(3)}ms`);
    console.log(`  Format: ${refJson.substring(0, 100)}...`);
    
    console.log(`\n📊 Tuple $lmz format:`);
    console.log(`  Size: ${tupleStyle.sizeMinified} bytes (${((tupleStyle.sizeMinified - current.sizeMinified) / current.sizeMinified * 100).toFixed(1)}% vs indexed)`);
    console.log(`  Serialize: ${tupleStyle.serializeTime.toFixed(3)}ms, Parse: ${tupleStyle.parseTime.toFixed(3)}ms`);
    console.log(`  Format: ${tupleJson.substring(0, 100)}...`);
    console.log(`  Readability: ✅ Compact tuples + human-readable type names`);
    
    console.log(`\n📈 Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format} (smallest size)`);
  });
  
  it('Cyclic object (self-reference)', async () => {
    const data = createCyclicObject();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Cyclic Object (Self-Reference) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Aliased object (same object, different paths)', async () => {
    const data = createAliasedObject();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Aliased Object (Same Object, Different Paths) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Deep nested structure', async () => {
    const data = createDeepNested(50);
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Deep Nested (50 levels) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Large shared subtree', async () => {
    const data = createLargeSharedSubtree();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Large Shared Subtree ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Complex structure (Map, Set, RegExp, etc.)', async () => {
    const data = createComplexStructure();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Complex Structure (Map, Set, RegExp) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Mixed workload (50% simple, 50% aliased)', async () => {
    // Create a mix: some simple objects, some with aliases
    const simple = createSimpleObject();
    const aliased = createAliasedObject();
    const cyclic = createCyclicObject();
    
    // Mix them together
    const mixed = {
      simple1: simple,
      simple2: createSimpleObject(),
      aliased1: aliased,
      aliased2: createAliasedObject(),
      cyclic1: cyclic,
      simple3: { a: 1, b: 2, c: 3 },
      mixed: {
        shared: { id: 42, data: 'shared' },
        ref1: null as any,
        ref2: null as any
      }
    };
    mixed.mixed.ref1 = mixed.mixed.shared;
    mixed.mixed.ref2 = mixed.mixed.shared;
    
    const current = await benchmarkFormat('Current (indexed)', mixed, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', mixed, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', mixed, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Mixed Workload (50% Simple, 50% Aliased/Cyclic) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Error objects with stack traces and custom properties', async () => {
    const data = createErrorStructure();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Error Structure (with stack traces, custom properties) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
  
  it('Web API types (URL, Headers with verbose markers)', async () => {
    const data = createWebApiStructure();
    
    const current = await benchmarkFormat('Current (indexed)', data, serializeCurrentFormat, parseCurrentFormat);
    const refStyle = await benchmarkFormat('Object $lmz', data, serializeRefStyle, parseRefStyle);
    const tupleStyle = await benchmarkFormat('Tuple $lmz', data, serializeTupleStyle, parseTupleStyle);
    
    console.log('\n=== Web API Structure (URL, Headers) ===');
    console.log(`Indexed: ${current.sizeMinified}b | Object $lmz: ${refStyle.sizeMinified}b | Tuple $lmz: ${tupleStyle.sizeMinified}b`);
    console.log(`Winner: ${[current, refStyle, tupleStyle].sort((a, b) => a.sizeMinified - b.sizeMinified)[0].format}`);
  });
});

