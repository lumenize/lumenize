var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/ulid-workers/dist/ulid.js
var require_ulid = __commonJS({
  "../../node_modules/ulid-workers/dist/ulid.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.exportedForTesting = exports.ulidFactory = exports.decodeTime = exports.encodeTime = void 0;
    var ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    var ENCODING_LEN = ENCODING.length;
    var TIME_MAX = Math.pow(2, 48) - 1;
    var TIME_LEN = 10;
    var RANDOM_LEN = 16;
    function webCryptoPRNG() {
      const buffer = new Uint8Array(1);
      crypto.getRandomValues(buffer);
      return buffer[0] / 255;
    }
    function encodeRandom(len) {
      let str = "";
      for (; len > 0; len--) {
        str = randomChar() + str;
      }
      return str;
    }
    function validateTimestamp(timestamp) {
      if (isNaN(timestamp)) {
        throw new Error(`timestamp must be a number: ${timestamp}`);
      } else if (timestamp > TIME_MAX) {
        throw new Error(`cannot encode a timestamp larger than 2^48 - 1 (${TIME_MAX}) : ${timestamp}`);
      } else if (timestamp < 0) {
        throw new Error(`timestamp must be positive: ${timestamp}`);
      } else if (Number.isInteger(timestamp) === false) {
        throw new Error(`timestamp must be an integer: ${timestamp}`);
      }
    }
    function encodeTime(timestamp) {
      validateTimestamp(timestamp);
      let mod;
      let str = "";
      for (let tLen = TIME_LEN; tLen > 0; tLen--) {
        mod = timestamp % ENCODING_LEN;
        str = ENCODING.charAt(mod) + str;
        timestamp = (timestamp - mod) / ENCODING_LEN;
      }
      return str;
    }
    exports.encodeTime = encodeTime;
    function incrementBase32(str) {
      let done = void 0, index = str.length, char, charIndex, output = str;
      const maxCharIndex = ENCODING_LEN - 1;
      if (str.length > RANDOM_LEN) {
        throw new Error(`Base32 value to increment cannot be longer than ${RANDOM_LEN} characters`);
      }
      if (str === "Z".repeat(RANDOM_LEN)) {
        throw new Error(`Cannot increment Base32 maximum value ${"Z".repeat(RANDOM_LEN)}`);
      }
      while (!done && index-- >= 0) {
        char = output[index];
        charIndex = ENCODING.indexOf(char);
        if (charIndex === -1) {
          throw new Error("Incorrectly encoded string");
        }
        if (charIndex === maxCharIndex) {
          output = replaceCharAt(output, index, ENCODING[0]);
          continue;
        }
        done = replaceCharAt(output, index, ENCODING[charIndex + 1]);
      }
      if (typeof done === "string") {
        return done;
      }
      throw new Error("Failed incrementing string");
    }
    function randomChar() {
      let rand = Math.floor(webCryptoPRNG() * ENCODING_LEN);
      if (rand === ENCODING_LEN) {
        rand = ENCODING_LEN - 1;
      }
      return ENCODING.charAt(rand);
    }
    function replaceCharAt(str, index, char) {
      if (index > str.length - 1) {
        return str;
      }
      return str.substring(0, index) + char + str.substring(index + 1);
    }
    function decodeTime(id) {
      if (id.length !== TIME_LEN + RANDOM_LEN) {
        throw new Error("Malformed ULID");
      }
      const time = id.substring(0, TIME_LEN).split("").reverse().reduce((carry, char, index) => {
        const encodingIndex = ENCODING.indexOf(char);
        if (encodingIndex === -1) {
          throw new Error(`Time decode error: Invalid character: ${char}`);
        }
        return carry += encodingIndex * Math.pow(ENCODING_LEN, index);
      }, 0);
      if (time > TIME_MAX) {
        throw new Error(`Malformed ULID: timestamp too large: ${time}`);
      }
      return time;
    }
    exports.decodeTime = decodeTime;
    var ulidFactory2 = (args) => {
      const monotonic = args?.monotonic ?? true;
      if (monotonic) {
        return /* @__PURE__ */ (function() {
          let lastTime = 0;
          let lastRandom;
          return function(timestamp) {
            let timestampOrNow = timestamp || Date.now();
            validateTimestamp(timestampOrNow);
            if (timestampOrNow > lastTime) {
              lastTime = timestampOrNow;
              const random = encodeRandom(RANDOM_LEN);
              lastRandom = random;
              return encodeTime(timestampOrNow) + random;
            } else {
              const random = incrementBase32(lastRandom);
              lastRandom = random;
              return encodeTime(lastTime) + random;
            }
          };
        })();
      } else {
        return /* @__PURE__ */ (function() {
          return function(timestamp) {
            let timestampOrNow = timestamp || Date.now();
            validateTimestamp(timestampOrNow);
            return encodeTime(timestampOrNow) + encodeRandom(RANDOM_LEN);
          };
        })();
      }
    };
    exports.ulidFactory = ulidFactory2;
    exports.exportedForTesting = {
      encodeRandom,
      incrementBase32,
      randomChar,
      replaceCharAt,
      validateTimestamp,
      webCryptoPRNG
    };
  }
});

// ../../node_modules/ulid-workers/dist/index.js
var require_dist = __commonJS({
  "../../node_modules/ulid-workers/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ulidFactory = exports.encodeTime = exports.decodeTime = void 0;
    var ulid_1 = require_ulid();
    Object.defineProperty(exports, "decodeTime", { enumerable: true, get: function() {
      return ulid_1.decodeTime;
    } });
    Object.defineProperty(exports, "encodeTime", { enumerable: true, get: function() {
      return ulid_1.encodeTime;
    } });
    Object.defineProperty(exports, "ulidFactory", { enumerable: true, get: function() {
      return ulid_1.ulidFactory;
    } });
  }
});

// ../../packages/mesh/src/lumenize-do.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";

// ../../packages/mesh/src/ocan/types.ts
function isNestedOperationMarker(obj) {
  return obj && typeof obj === "object" && obj.__isNestedOperation === true;
}

// ../../packages/mesh/src/ocan/proxy-factory.ts
var proxyToOperationChain = /* @__PURE__ */ new WeakMap();
function getOperationChain(proxy) {
  return proxyToOperationChain.get(proxy);
}
function processArgumentsForNesting(args) {
  return args.map((arg) => {
    const chain = proxyToOperationChain.get(arg);
    if (chain) {
      return {
        __isNestedOperation: true,
        __operationChain: chain
      };
    }
    return arg;
  });
}
function newContinuation() {
  return createProxyWithChain([]);
}
function createProxyWithChain(chain) {
  const proxy = new Proxy(() => {
  }, {
    get(target, key) {
      if (typeof key === "symbol") {
        return void 0;
      }
      const newChain = [...chain, { type: "get", key }];
      return createProxyWithChain(newChain);
    },
    apply(target, thisArg, args) {
      const processedArgs = processArgumentsForNesting(args);
      const newChain = [...chain, { type: "apply", args: processedArgs }];
      return createProxyWithChain(newChain);
    }
  });
  proxyToOperationChain.set(proxy, chain);
  return proxy;
}

// ../../packages/mesh/src/mesh-decorator.ts
var MESH_CALLABLE = /* @__PURE__ */ Symbol.for("lumenize.mesh.callable");
var MESH_GUARD = /* @__PURE__ */ Symbol.for("lumenize.mesh.guard");
function isMeshCallable(method) {
  return typeof method === "function" && method[MESH_CALLABLE] === true;
}
function getMeshGuard(method) {
  if (typeof method === "function") {
    return method[MESH_GUARD];
  }
  return void 0;
}
function meshFn(fn) {
  fn[MESH_CALLABLE] = true;
  return fn;
}
function mesh(guard) {
  return function(target, _context) {
    target[MESH_CALLABLE] = true;
    if (guard) {
      target[MESH_GUARD] = guard;
    }
    return target;
  };
}

// ../../packages/mesh/src/ocan/execute.ts
var DEFAULT_CONFIG = {
  maxDepth: 50,
  maxArgs: 100,
  requireMeshDecorator: true
  // Secure by default - only @mesh decorated methods are callable
};
function validateOperationChain(operations, config = {}) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  if (!Array.isArray(operations)) {
    throw new Error("Invalid operation chain: operations must be an array");
  }
  if (operations.length > finalConfig.maxDepth) {
    throw new Error(`Operation chain too deep: ${operations.length} > ${finalConfig.maxDepth}`);
  }
  for (const operation of operations) {
    if (operation.type === "apply" && operation.args.length > finalConfig.maxArgs) {
      throw new Error(`Too many arguments: ${operation.args.length} > ${finalConfig.maxArgs}`);
    }
  }
}
async function executeOperationChain(operations, target, config) {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  validateOperationChain(operations, config);
  let current = target;
  let entryPointChecked = false;
  for (let i = 0; i < operations.length; i++) {
    const operation = operations[i];
    if (operation.type === "get") {
      current = current[operation.key];
    } else if (operation.type === "apply") {
      if (typeof current !== "function") {
        throw new Error(`TypeError: ${String(current)} is not a function`);
      }
      if (finalConfig.requireMeshDecorator && !entryPointChecked) {
        entryPointChecked = true;
        const prevOp2 = i > 0 ? operations[i - 1] : null;
        const isServiceCall = operations[0]?.type === "get" && operations[0]?.key === "svc";
        if (prevOp2?.type === "get" && !isServiceCall) {
          const methodName = prevOp2.key;
          const parent2 = findParentObject(operations.slice(0, i), target);
          const method = parent2[methodName];
          if (!isMeshCallable(method)) {
            throw new Error(
              `Method '${String(methodName)}' is not mesh-callable. Add the @mesh decorator to allow remote calls.`
            );
          }
          const guard = getMeshGuard(method);
          if (guard) {
            await guard(target);
          }
        }
      }
      const resolvedArgs = await resolveNestedOperations(operation.args, target, config);
      const parent = findParentObject(operations.slice(0, i), target);
      const prevOp = i > 0 ? operations[i - 1] : null;
      if (prevOp?.type === "get") {
        const methodName = prevOp.key;
        current = await parent[methodName](...resolvedArgs);
      } else {
        current = await current.apply(parent, resolvedArgs);
      }
    }
  }
  return current;
}
async function resolveNestedOperations(args, target, config) {
  let hasNestedMarkers = false;
  function checkForMarkers(value, seen = /* @__PURE__ */ new WeakSet()) {
    if (isNestedOperationMarker(value)) {
      return true;
    }
    if (value && typeof value === "object") {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
    }
    if (Array.isArray(value)) {
      return value.some((v) => checkForMarkers(v, seen));
    }
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.values(value).some((v) => checkForMarkers(v, seen));
    }
    return false;
  }
  hasNestedMarkers = args.some((v) => checkForMarkers(v));
  if (!hasNestedMarkers) {
    return args;
  }
  const resolved = [];
  for (const arg of args) {
    if (isNestedOperationMarker(arg)) {
      if (!arg.__operationChain) {
        throw new Error("Invalid nested operation marker: missing __operationChain");
      }
      const nestedResult = await executeOperationChain(
        arg.__operationChain,
        target,
        config
      );
      resolved.push(nestedResult);
    } else if (Array.isArray(arg)) {
      const resolvedArray = await resolveNestedOperations(arg, target, config);
      resolved.push(resolvedArray === arg ? arg : resolvedArray);
    } else if (arg && typeof arg === "object" && Object.getPrototypeOf(arg) === Object.prototype) {
      let hasChanges = false;
      const resolvedObj = {};
      for (const [key, value] of Object.entries(arg)) {
        if (isNestedOperationMarker(value)) {
          if (!value.__operationChain) {
            throw new Error("Invalid nested operation marker: missing __operationChain");
          }
          resolvedObj[key] = await executeOperationChain(
            value.__operationChain,
            target,
            config
          );
          hasChanges = true;
        } else if (Array.isArray(value)) {
          const resolvedValue = await resolveNestedOperations(value, target, config);
          resolvedObj[key] = resolvedValue;
          if (resolvedValue !== value) hasChanges = true;
        } else {
          resolvedObj[key] = value;
        }
      }
      resolved.push(hasChanges ? resolvedObj : arg);
    } else {
      resolved.push(arg);
    }
  }
  return resolved;
}
function findParentObject(operations, target) {
  if (operations.length === 0) return target;
  let parent = target;
  for (const operation of operations.slice(0, -1)) {
    if (operation.type === "get") {
      parent = parent[operation.key];
    } else if (operation.type === "apply") {
      const grandParent = findParentObject(operations.slice(0, operations.indexOf(operation)), target);
      parent = parent.apply(grandParent, operation.args);
    }
  }
  return parent;
}
function replaceNestedOperationMarkers(chain, resultValue) {
  return chain.map((op, i) => {
    if (op.type === "apply" && i === chain.length - 1) {
      let hasNestedMarker = false;
      const args = op.args.map((arg) => {
        if (isNestedOperationMarker(arg)) {
          hasNestedMarker = true;
          return resultValue;
        }
        return arg;
      });
      if (!hasNestedMarker) {
        return {
          ...op,
          args: [...op.args, resultValue]
        };
      }
      return {
        ...op,
        args
      };
    }
    return op;
  });
}

// ../../packages/routing/src/is-durable-object-id.ts
function isDurableObjectId(value) {
  return /^[a-f0-9]{64}$/.test(value);
}

// ../../packages/routing/src/get-do-stub.ts
function getDOStub(doNamespace, doInstanceNameOrId) {
  if (isDurableObjectId(doInstanceNameOrId)) {
    const id = doNamespace.idFromString(doInstanceNameOrId);
    return doNamespace.get(id);
  } else {
    return doNamespace.getByName(doInstanceNameOrId);
  }
}

// ../../packages/debug/src/pattern-matcher.ts
var LEVEL_PRIORITY = {
  "debug": 0,
  // Most verbose
  "info": 1,
  "warn": 2,
  "error": 3
  // Never filtered in practice
};
function parseDebugFilter(filter) {
  if (!filter) return [];
  const patterns = [];
  const parts = filter.split(/[,\s]+/).filter((p) => p.length > 0);
  for (const part of parts) {
    const exclude = part.startsWith("-");
    const cleaned = exclude ? part.slice(1) : part;
    const colonIndex = cleaned.lastIndexOf(":");
    let pattern;
    let level;
    if (colonIndex > 0) {
      pattern = cleaned.slice(0, colonIndex);
      const levelStr = cleaned.slice(colonIndex + 1);
      if (levelStr === "debug" || levelStr === "info" || levelStr === "warn" || levelStr === "error") {
        level = levelStr;
      }
    } else {
      pattern = cleaned;
    }
    patterns.push({ pattern, level, exclude });
  }
  return patterns;
}
function namespaceMatches(namespace, pattern) {
  if (namespace === pattern) return true;
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return namespace === prefix || namespace.startsWith(prefix + ".");
  }
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return namespace === prefix || namespace.startsWith(prefix);
  }
  return namespace.startsWith(pattern + ".");
}
function levelMatches(logLevel, patternLevel) {
  if (!patternLevel) return true;
  return LEVEL_PRIORITY[logLevel] >= LEVEL_PRIORITY[patternLevel];
}
function shouldLog(namespace, level, filter) {
  if (filter.length === 0) return false;
  let included = false;
  let excluded = false;
  for (const { pattern, level: patternLevel, exclude } of filter) {
    if (!namespaceMatches(namespace, pattern)) continue;
    if (!levelMatches(level, patternLevel)) continue;
    if (exclude) {
      excluded = true;
    } else {
      included = true;
    }
  }
  return included && !excluded;
}
function createMatcher(debugEnv) {
  const patterns = parseDebugFilter(debugEnv);
  return (namespace, level) => shouldLog(namespace, level, patterns);
}

// ../../packages/debug/src/logger.ts
function safeReplacer() {
  const seen = /* @__PURE__ */ new WeakSet();
  return (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString() + "n";
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
}
function defaultOutput(log) {
  console.debug(JSON.stringify(log, safeReplacer(), 2));
}
var DebugLoggerImpl = class {
  namespace;
  #shouldLog;
  #output;
  #enabledCache;
  constructor(config) {
    this.namespace = config.namespace;
    this.#shouldLog = config.shouldLog;
    this.#output = config.output || defaultOutput;
    this.#enabledCache = /* @__PURE__ */ new Map();
    this.#enabledCache.set("debug", this.#shouldLog(this.namespace, "debug"));
    this.#enabledCache.set("info", this.#shouldLog(this.namespace, "info"));
    this.#enabledCache.set("warn", this.#shouldLog(this.namespace, "warn"));
  }
  /**
   * Check if any level is enabled (useful for expensive pre-computations)
   */
  get enabled() {
    return this.#enabledCache.get("debug") || this.#enabledCache.get("info") || this.#enabledCache.get("warn") || false;
  }
  /**
   * Internal method to log at a specific level (for filterable levels only)
   */
  #log(level, message, data, _options) {
    if (!this.#enabledCache.get(level)) return;
    const log = {
      type: "debug",
      level,
      namespace: this.namespace,
      message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (data !== void 0) {
      log.data = data;
    }
    this.#output(log);
  }
  /**
   * Internal method to create and output a log (bypasses filter check)
   */
  #logMessage(level, message, data) {
    const log = {
      type: "debug",
      level,
      namespace: this.namespace,
      message,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (data !== void 0) {
      log.data = data;
    }
    this.#output(log);
  }
  debug(message, data, options) {
    this.#log("debug", message, data, options);
  }
  info(message, data, options) {
    this.#log("info", message, data, options);
  }
  warn(message, data, options) {
    this.#log("warn", message, data, options);
  }
  /**
   * Log at error level - **ALWAYS OUTPUTS, NEVER FILTERED**
   *
   * Error logs ignore the DEBUG environment variable and always output.
   * Use for true system errors, bugs, and unexpected failures that should NEVER be hidden.
   *
   * For expected operational issues (retry exhausted, auth failed, rate limited),
   * use `warn()` instead - those are filterable and should be.
   */
  error(message, data, _options) {
    this.#logMessage("error", message, data);
  }
};

// ../../packages/debug/src/index.ts
var cfEnv = null;
try {
  const mod = await import("cloudflare:workers");
  cfEnv = mod.env ?? null;
} catch {
}
var cachedMatcher = null;
var cachedDebugValue = null;
function getDebugFilter() {
  if (cfEnv?.DEBUG !== void 0) {
    return cfEnv.DEBUG;
  }
  if (typeof process !== "undefined" && process?.env?.DEBUG !== void 0) {
    return process.env.DEBUG;
  }
  if (typeof localStorage !== "undefined") {
    try {
      return localStorage.getItem("DEBUG") ?? void 0;
    } catch {
      return void 0;
    }
  }
  return void 0;
}
function getMatcher() {
  const currentDebugValue = getDebugFilter();
  if (cachedMatcher !== null && cachedDebugValue === currentDebugValue) {
    return cachedMatcher;
  }
  cachedDebugValue = currentDebugValue;
  cachedMatcher = createMatcher(currentDebugValue);
  return cachedMatcher;
}
function debug(namespace) {
  return new DebugLoggerImpl({
    namespace,
    shouldLog: getMatcher()
  });
}
debug.reset = function() {
  cachedMatcher = null;
  cachedDebugValue = null;
};

// ../../packages/structured-clone/src/request-sync.ts
var RequestSync = class _RequestSync {
  /** Internal Request object (metadata only, no body stream) */
  _request;
  /** Serializable body (string, ArrayBuffer, or plain object) */
  body;
  /**
   * Create a RequestSync
   * 
   * @param input - URL or Request object
   * @param init - Request options with serializable body
   */
  constructor(input, init) {
    const { body, ...requestInit } = init || {};
    this._request = new Request(input, requestInit);
    this.body = body ?? null;
  }
  // ===== Synchronous Body Readers =====
  /**
   * Get body as parsed JSON (synchronous)
   * 
   * @returns Parsed JSON object or null if no body
   */
  json() {
    if (typeof this.body === "string") {
      return JSON.parse(this.body);
    }
    if (this.body instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(this.body));
    }
    if (typeof this.body === "object" && this.body !== null) {
      return this.body;
    }
    return null;
  }
  /**
   * Get body as text string (synchronous)
   * 
   * @returns Text representation of body
   */
  text() {
    if (typeof this.body === "string") {
      return this.body;
    }
    if (this.body instanceof ArrayBuffer) {
      return new TextDecoder().decode(this.body);
    }
    if (typeof this.body === "object" && this.body !== null) {
      return JSON.stringify(this.body);
    }
    return "";
  }
  /**
   * Get body as ArrayBuffer (synchronous)
   * 
   * @returns ArrayBuffer representation of body
   */
  arrayBuffer() {
    if (this.body instanceof ArrayBuffer) {
      return this.body;
    }
    if (typeof this.body === "string") {
      return new TextEncoder().encode(this.body).buffer;
    }
    if (typeof this.body === "object" && this.body !== null) {
      return new TextEncoder().encode(JSON.stringify(this.body)).buffer;
    }
    return new ArrayBuffer(0);
  }
  /**
   * Get body as Blob (synchronous)
   * 
   * @returns Blob containing body data
   */
  blob() {
    return new Blob([this.arrayBuffer()]);
  }
  /**
   * FormData not supported in sync mode
   * 
   * @throws {Error} Always throws - use json() or text() instead
   */
  formData() {
    throw new Error("FormData not supported in RequestSync - use json() or text() instead");
  }
  // ===== Metadata Forwarders =====
  /** Request URL */
  get url() {
    return this._request.url;
  }
  /** HTTP method */
  get method() {
    return this._request.method;
  }
  /** Request headers */
  get headers() {
    return this._request.headers;
  }
  /** Abort signal */
  get signal() {
    return this._request.signal;
  }
  /** Credentials mode */
  get credentials() {
    return this._request.credentials;
  }
  /** Referrer URL */
  get referrer() {
    return this._request.referrer;
  }
  /** Referrer policy */
  get referrerPolicy() {
    return this._request.referrerPolicy;
  }
  /** Request mode */
  get mode() {
    return this._request.mode;
  }
  /** Cache mode */
  get cache() {
    return this._request.cache;
  }
  /** Redirect mode */
  get redirect() {
    return this._request.redirect;
  }
  /** Subresource integrity */
  get integrity() {
    return this._request.integrity;
  }
  /** Keep-alive flag */
  get keepalive() {
    return this._request.keepalive;
  }
  /** Request destination */
  get destination() {
    return this._request.destination;
  }
  // ===== Utility Methods =====
  /**
   * Clone this RequestSync
   * 
   * @returns New RequestSync with same properties
   */
  clone() {
    return new _RequestSync(this._request.url, {
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
  toRequest() {
    const bodyInit = this.body && typeof this.body === "object" && !(this.body instanceof ArrayBuffer) ? JSON.stringify(this.body) : this.body;
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
};

// ../../packages/structured-clone/src/response-sync.ts
var ResponseSync = class _ResponseSync {
  /** Internal Response object (metadata only, no body stream) */
  _response;
  /** Serializable body (string, ArrayBuffer, or plain object) */
  body;
  /**
   * Create a ResponseSync
   * 
   * @param body - Serializable body (string, ArrayBuffer, or plain object)
   * @param init - Response options (status, headers, etc.)
   */
  constructor(body, init) {
    this._response = new Response(null, init);
    this.body = body ?? null;
  }
  // ===== Synchronous Body Readers =====
  /**
   * Get body as parsed JSON (synchronous)
   * 
   * @returns Parsed JSON object or null if no body
   */
  json() {
    if (typeof this.body === "string") {
      return JSON.parse(this.body);
    }
    if (this.body instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(this.body));
    }
    if (typeof this.body === "object" && this.body !== null) {
      return this.body;
    }
    return null;
  }
  /**
   * Get body as text string (synchronous)
   * 
   * @returns Text representation of body
   */
  text() {
    if (typeof this.body === "string") {
      return this.body;
    }
    if (this.body instanceof ArrayBuffer) {
      return new TextDecoder().decode(this.body);
    }
    if (typeof this.body === "object" && this.body !== null) {
      return JSON.stringify(this.body);
    }
    return "";
  }
  /**
   * Get body as ArrayBuffer (synchronous)
   * 
   * @returns ArrayBuffer representation of body
   */
  arrayBuffer() {
    if (this.body instanceof ArrayBuffer) {
      return this.body;
    }
    if (typeof this.body === "string") {
      return new TextEncoder().encode(this.body).buffer;
    }
    if (typeof this.body === "object" && this.body !== null) {
      return new TextEncoder().encode(JSON.stringify(this.body)).buffer;
    }
    return new ArrayBuffer(0);
  }
  /**
   * Get body as Blob (synchronous)
   * 
   * @returns Blob containing body data
   */
  blob() {
    return new Blob([this.arrayBuffer()]);
  }
  /**
   * FormData not supported in sync mode
   * 
   * @throws {Error} Always throws - use json() or text() instead
   */
  formData() {
    throw new Error("FormData not supported in ResponseSync - use json() or text() instead");
  }
  // ===== Metadata Forwarders =====
  /** HTTP status code */
  get status() {
    return this._response.status;
  }
  /** HTTP status text */
  get statusText() {
    return this._response.statusText;
  }
  /** Response headers */
  get headers() {
    return this._response.headers;
  }
  /** Whether response is successful (status 200-299) */
  get ok() {
    return this._response.ok;
  }
  /** Whether response was redirected */
  get redirected() {
    return this._response.redirected;
  }
  /** Response type */
  get type() {
    return this._response.type;
  }
  /** Response URL */
  get url() {
    return this._response.url;
  }
  // ===== Utility Methods =====
  /**
   * Clone this ResponseSync
   * 
   * @returns New ResponseSync with same properties
   */
  clone() {
    return new _ResponseSync(this.body, {
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
  toResponse() {
    const bodyInit = this.body && typeof this.body === "object" && !(this.body instanceof ArrayBuffer) ? JSON.stringify(this.body) : this.body;
    return new Response(bodyInit, {
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
   * @returns Promise\<ResponseSync\>
   * 
   * @example
   * ```typescript
   * const response = await fetch('https://api.example.com/data');
   * const syncResponse = await ResponseSync.fromResponse(response);
   * // Now can serialize syncResponse with structured-clone (sync!)
   * ```
   */
  static async fromResponse(response) {
    let body = null;
    if (response.body && !response.bodyUsed) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else if (contentType.includes("text/") || contentType.includes("application/javascript")) {
        body = await response.text();
      } else {
        body = await response.arrayBuffer();
      }
    }
    return new _ResponseSync(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
};

// ../../packages/structured-clone/src/web-api-encoding.ts
function headersToArray(headers) {
  const entries = [];
  headers.forEach((value, key) => {
    entries.push([key, value]);
  });
  return entries;
}
function defaultEncodeHeaders(headers) {
  return headersToArray(headers);
}
function defaultDeencodeHeaders(data) {
  if (data instanceof Headers) return data;
  return new Headers(data);
}
function encodeRequestSync(request, encodeHeaders = defaultEncodeHeaders) {
  return {
    url: request.url,
    method: request.method,
    headers: encodeHeaders(request.headers),
    body: request.body
    // Direct access to stored body
  };
}
function decodeRequestSync(data, decodeHeaders = defaultDeencodeHeaders) {
  return new RequestSync(data.url, {
    method: data.method,
    headers: decodeHeaders(data.headers),
    body: data.body
  });
}
function encodeResponseSync(response, encodeHeaders = defaultEncodeHeaders) {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: encodeHeaders(response.headers),
    body: response.body
    // Direct access to stored body
  };
}
function decodeResponseSync(data, decodeHeaders = defaultDeencodeHeaders) {
  return new ResponseSync(data.body, {
    status: data.status,
    statusText: data.statusText,
    headers: decodeHeaders(data.headers)
  });
}

// ../../packages/structured-clone/src/preprocess.ts
var TRANSFORM_SKIP = /* @__PURE__ */ Symbol("TRANSFORM_SKIP");
function preprocess(data, options) {
  const seen = /* @__PURE__ */ new WeakMap();
  const objects = [];
  let nextId = 0;
  const transform = options?.transform;
  function preprocessValue(value, path = []) {
    if (transform) {
      const transformed = transform(value, { seen, nextId, objects, path });
      if (transformed !== TRANSFORM_SKIP) {
        if (transformed && typeof transformed === "object") {
          if (transformed.__lmzId !== void 0) {
            const id = transformed.__lmzId;
            delete transformed.__lmzId;
            seen.set(value, id);
            objects[id] = transformed;
            nextId = Math.max(nextId, id + 1);
            return ["$lmz", id];
          }
        }
        return transformed;
      }
    }
    if (typeof value === "symbol") {
      throw new TypeError("unable to serialize symbol");
    }
    if (value === null) return ["null"];
    if (value === void 0) return ["undefined"];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "number") {
      if (Number.isNaN(value)) return ["number", "NaN"];
      if (value === Infinity) return ["number", "Infinity"];
      if (value === -Infinity) return ["number", "-Infinity"];
      return ["number", value];
    }
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "bigint") return ["bigint", value.toString()];
    if (typeof value === "function") {
      const id = nextId++;
      seen.set(value, id);
      const tuple = ["function", {
        name: value.name || "anonymous"
      }];
      objects[id] = tuple;
      return ["$lmz", id];
    }
    if (typeof value === "object") {
      if (seen.has(value)) {
        return ["$lmz", seen.get(value)];
      }
      const id = nextId++;
      seen.set(value, id);
      if (Array.isArray(value)) {
        const items = [];
        for (let i = 0; i < value.length; i++) {
          items.push(preprocessValue(value[i], [...path, { type: "index", key: i }]));
        }
        const tuple2 = ["array", items];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof Map) {
        const entries = [];
        for (const [key, val] of value) {
          entries.push([preprocessValue(key, path), preprocessValue(val, path)]);
        }
        const tuple2 = ["map", entries];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof Set) {
        const values = [];
        for (const item of value) {
          values.push(preprocessValue(item, path));
        }
        const tuple2 = ["set", values];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof Date) {
        return ["date", value.toISOString()];
      } else if (value instanceof RegExp) {
        return ["regexp", { source: value.source, flags: value.flags }];
      } else if (value instanceof Error) {
        const errorData = {
          name: value.name || "Error",
          message: value.message || ""
        };
        if (value.stack) errorData.stack = value.stack;
        if (value.cause !== void 0) errorData.cause = preprocessValue(value.cause, [...path, { type: "get", key: "cause" }]);
        const allProps = Object.getOwnPropertyNames(value);
        for (const key of allProps) {
          if (!["name", "message", "stack", "cause"].includes(key)) {
            try {
              errorData[key] = preprocessValue(value[key], [...path, { type: "get", key }]);
            } catch {
            }
          }
        }
        const tuple2 = ["error", errorData];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof Headers) {
        const entries = [];
        value.forEach((val, key) => {
          entries.push([key, val]);
        });
        const tuple2 = ["headers", entries];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof URL) {
        const tuple2 = ["url", { href: value.href }];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value.constructor?.name === "RequestSync") {
        const data2 = encodeRequestSync(
          value,
          (headers) => preprocessValue(headers)
        );
        const tuple2 = ["request-sync", data2];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value.constructor?.name === "ResponseSync") {
        const data2 = encodeResponseSync(
          value,
          (headers) => preprocessValue(headers)
        );
        const tuple2 = ["response-sync", data2];
        objects[id] = tuple2;
        return ["$lmz", id];
      } else if (value instanceof Request) {
        throw new Error("Cannot serialize native Request object. Use RequestSync instead.");
      } else if (value instanceof Response) {
        throw new Error("Cannot serialize native Response object. Use ResponseSync instead.");
      } else if (value instanceof Boolean) {
        return ["boolean-object", value.valueOf()];
      } else if (value instanceof Number) {
        const num = value.valueOf();
        if (Number.isNaN(num)) return ["number-object", "NaN"];
        if (num === Infinity) return ["number-object", "Infinity"];
        if (num === -Infinity) return ["number-object", "-Infinity"];
        return ["number-object", num];
      } else if (value instanceof String) {
        return ["string-object", value.valueOf()];
      } else if (typeof BigInt !== "undefined" && value instanceof Object && value.constructor.name === "BigInt") {
        return ["bigint-object", value.valueOf().toString()];
      } else if (typeof value.constructor === "function") {
        const constructorName = value.constructor.name;
        if (constructorName === "ArrayBuffer") {
          const id2 = nextId++;
          seen.set(value, id2);
          const arr = Array.from(new Uint8Array(value));
          const tuple2 = ["arraybuffer", { type: "ArrayBuffer", data: arr }];
          objects[id2] = tuple2;
          return ["$lmz", id2];
        } else if (constructorName === "DataView") {
          const id2 = nextId++;
          seen.set(value, id2);
          const buffer = Array.from(new Uint8Array(value.buffer));
          const tuple2 = ["arraybuffer", {
            type: "DataView",
            data: buffer,
            byteOffset: value.byteOffset,
            byteLength: value.byteLength
          }];
          objects[id2] = tuple2;
          return ["$lmz", id2];
        } else if (constructorName.includes("Array") && value.buffer) {
          const id2 = nextId++;
          seen.set(value, id2);
          const arr = Array.from(value);
          const tuple2 = ["arraybuffer", { type: constructorName, data: arr }];
          objects[id2] = tuple2;
          return ["$lmz", id2];
        }
      }
      const obj = {};
      for (const key in value) {
        obj[key] = preprocessValue(value[key], [...path, { type: "get", key }]);
      }
      const tuple = ["object", obj];
      objects[id] = tuple;
      return ["$lmz", id];
    }
    return value;
  }
  const root = preprocessValue(data, []);
  return { root, objects };
}

// ../../packages/structured-clone/src/postprocess.ts
function postprocess(data) {
  const objects = /* @__PURE__ */ new Map();
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      const [type, value] = tuple;
      if (type === "array") {
        objects.set(i, []);
      } else if (type === "map") {
        objects.set(i, /* @__PURE__ */ new Map());
      } else if (type === "set") {
        objects.set(i, /* @__PURE__ */ new Set());
      } else if (type === "error") {
        const ErrorConstructor = globalThis[value.name] || Error;
        const error = new ErrorConstructor(value.message || "");
        error.name = value.name;
        if (value.stack !== void 0) {
          error.stack = value.stack;
        } else {
          delete error.stack;
        }
        objects.set(i, error);
      } else if (type === "headers") {
        objects.set(i, new Headers(value));
      } else if (type === "url") {
        objects.set(i, new URL(value.href));
      } else if (type === "arraybuffer") {
        if (value.type === "ArrayBuffer") {
          objects.set(i, new Uint8Array(value.data).buffer);
        } else if (value.type === "DataView") {
          const buffer = new Uint8Array(value.data).buffer;
          objects.set(i, new DataView(buffer, value.byteOffset, value.byteLength));
        } else {
          const TypedArrayConstructor = globalThis[value.type];
          if (TypedArrayConstructor) {
            objects.set(i, new TypedArrayConstructor(value.data));
          }
        }
      } else if (type === "function") {
        objects.set(i, {});
      } else if (type === "request" || type === "response" || type === "request-sync" || type === "response-sync") {
        objects.set(i, null);
      } else if (type === "object") {
        objects.set(i, {});
      }
    }
  }
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      const [type, value] = tuple;
      if (type === "request-sync") {
        const reconstructed = decodeRequestSync(
          value,
          (headerRef) => {
            if (Array.isArray(headerRef) && headerRef[0] === "$lmz") {
              return objects.get(headerRef[1]);
            }
            return headerRef;
          }
        );
        objects.set(i, reconstructed);
      } else if (type === "response-sync") {
        const reconstructed = decodeResponseSync(
          value,
          (headerRef) => {
            if (Array.isArray(headerRef) && headerRef[0] === "$lmz") {
              return objects.get(headerRef[1]);
            }
            return headerRef;
          }
        );
        objects.set(i, reconstructed);
      }
    }
  }
  if (data.objects) {
    for (let i = 0; i < data.objects.length; i++) {
      const tuple = data.objects[i];
      if (!tuple || !Array.isArray(tuple)) continue;
      const [type, value] = tuple;
      const obj = objects.get(i);
      if (type === "array") {
        for (const item of value) {
          obj.push(resolveValue(item, objects));
        }
      } else if (type === "map") {
        for (const [key, val] of value) {
          obj.set(
            resolveValue(key, objects),
            resolveValue(val, objects)
          );
        }
      } else if (type === "set") {
        for (const item of value) {
          obj.add(resolveValue(item, objects));
        }
      } else if (type === "error") {
        if (value.cause !== void 0) {
          obj.cause = resolveValue(value.cause, objects);
        }
        for (const key in value) {
          if (!["name", "message", "stack", "cause"].includes(key)) {
            obj[key] = resolveValue(value[key], objects);
          }
        }
      } else if (type === "headers" || type === "url") {
      } else if (type === "function") {
        const funcMarker = objects.get(i);
        for (const key in value) {
          funcMarker[key] = value[key];
        }
      } else if (type === "request" || type === "response" || type === "request-sync" || type === "response-sync") {
      } else if (type === "object") {
        for (const key in value) {
          obj[key] = resolveValue(value[key], objects);
        }
      }
    }
  }
  return resolveValue(data.root, objects);
}
function resolveValue(value, objects) {
  if (!value || !Array.isArray(value)) return value;
  const [type, data] = value;
  if (type === "$lmz") {
    return objects.get(data);
  }
  if (type === "null") return null;
  if (type === "undefined") return void 0;
  if (type === "string") return data;
  if (type === "number") {
    if (data === "NaN") return NaN;
    if (data === "Infinity") return Infinity;
    if (data === "-Infinity") return -Infinity;
    return data;
  }
  if (type === "boolean") return data;
  if (type === "bigint") return BigInt(data);
  if (type === "boolean-object") return new Boolean(data);
  if (type === "number-object") {
    if (data === "NaN") return new Number(NaN);
    if (data === "Infinity") return new Number(Infinity);
    if (data === "-Infinity") return new Number(-Infinity);
    return new Number(data);
  }
  if (type === "string-object") return new String(data);
  if (type === "bigint-object") return Object(BigInt(data));
  if (type === "date") return new Date(data);
  if (type === "regexp") return new RegExp(data.source, data.flags);
  return value;
}

// ../../packages/structured-clone/src/index.ts
function parse(value) {
  return postprocess(JSON.parse(value));
}

// ../../packages/mesh/src/lmz-api.ts
import { AsyncLocalStorage } from "node:async_hooks";
var callContextStorage = new AsyncLocalStorage();
function getCurrentCallContext() {
  return callContextStorage.getStore();
}
function runWithCallContext(context, fn) {
  return callContextStorage.run(context, fn);
}
function captureCallContext() {
  const current = callContextStorage.getStore();
  if (!current) return void 0;
  return {
    ...current,
    callChain: [...current.callChain],
    state: { ...current.state }
  };
}
function extractCallChains(remoteContinuation, handlerContinuation) {
  const remoteChain = getOperationChain(remoteContinuation);
  if (!remoteChain) {
    throw new Error("Invalid remoteContinuation: must be created with this.ctn()");
  }
  let handlerChain;
  if (handlerContinuation) {
    handlerChain = getOperationChain(handlerContinuation);
    if (!handlerChain) {
      throw new Error("Invalid handlerContinuation: must be created with this.ctn()");
    }
  }
  return { remoteChain, handlerChain };
}
function createHandlerExecutor(localExecutor, capturedContext) {
  return async (chain) => {
    if (capturedContext) {
      return runWithCallContext(capturedContext, async () => {
        return await localExecutor(chain, { requireMeshDecorator: false });
      });
    } else {
      return await localExecutor(chain, { requireMeshDecorator: false });
    }
  };
}
async function executeHandlerWithResult(handlerChain, resultOrError, executeHandler) {
  if (!handlerChain) return;
  const value = resultOrError instanceof Error ? resultOrError : resultOrError;
  const finalChain = replaceNestedOperationMarkers(handlerChain, value);
  await executeHandler(finalChain);
}
function setupFireAndForgetHandler(callPromise, handlerChain, executeHandler) {
  return callPromise.then(async (result) => {
    await executeHandlerWithResult(handlerChain, result, executeHandler);
  }).catch(async (error) => {
    const errorObj = error instanceof Error ? error : new Error(String(error));
    await executeHandlerWithResult(handlerChain, errorObj, executeHandler);
  });
}
function buildOutgoingCallContext(callerIdentity, options) {
  const currentContext = getCurrentCallContext();
  if (options?.newChain || !currentContext) {
    return {
      callChain: [callerIdentity],
      originAuth: void 0,
      state: options?.state ?? {}
    };
  }
  const newCallChain = [...currentContext.callChain, callerIdentity];
  const newState = options?.state ? { ...currentContext.state, ...options.state } : currentContext.state;
  return {
    callChain: newCallChain,
    originAuth: currentContext.originAuth,
    state: newState
  };
}
function createLmzApiForDO(ctx, env, doInstance) {
  function setBindingName(value) {
    const stored = ctx.storage.kv.get("__lmz_do_binding_name");
    if (stored !== void 0 && stored !== value) {
      throw new Error(
        `DO binding name mismatch: stored '${stored}' but received '${value}'. A DO instance cannot change its binding name.`
      );
    }
    ctx.storage.kv.put("__lmz_do_binding_name", value);
  }
  function setInstanceName(value) {
    const stored = ctx.storage.kv.get("__lmz_do_instance_name");
    if (stored !== void 0 && stored !== value) {
      throw new Error(
        `DO instance name mismatch: stored '${stored}' but received '${value}'. A DO instance cannot change its name.`
      );
    }
    ctx.storage.kv.put("__lmz_do_instance_name", value);
  }
  return {
    // --- Getters (all readonly) ---
    get bindingName() {
      return ctx.storage.kv.get("__lmz_do_binding_name");
    },
    get instanceName() {
      return ctx.storage.kv.get("__lmz_do_instance_name");
    },
    get type() {
      return "LumenizeDO";
    },
    get callContext() {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          "Cannot access callContext outside of a mesh call. callContext is only available during @mesh handler execution."
        );
      }
      return context;
    },
    // --- Internal init method (called by __initFromHeaders and envelope processing) ---
    /**
     * @internal Initialize identity - not for external use
     */
    __init(options) {
      if (options.bindingName !== void 0) {
        setBindingName(options.bindingName);
      }
      if (options.instanceName !== void 0) {
        setInstanceName(options.instanceName);
      }
    },
    async callRaw(calleeBindingName, calleeInstanceName, chainOrContinuation, options) {
      const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;
      const callerIdentity = {
        type: this.type,
        bindingName: this.bindingName,
        instanceName: this.instanceName
      };
      const calleeType = calleeInstanceName ? "LumenizeDO" : "LumenizeWorker";
      const callContext = buildOutgoingCallContext(callerIdentity, options);
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceName: this.instanceName
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceName: calleeInstanceName
        }
      };
      const envelope = {
        version: 1,
        chain: preprocess(chain),
        callContext,
        metadata
      };
      let stub;
      if (calleeType === "LumenizeDO") {
        stub = getDOStub(env[calleeBindingName], calleeInstanceName);
      } else {
        stub = env[calleeBindingName];
      }
      const response = await stub.__executeOperation(envelope);
      if (response && "$error" in response) {
        throw postprocess(response.$error);
      }
      return response?.$result;
    },
    call(calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options) {
      const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);
      if (!this.bindingName) {
        throw new Error(
          `Cannot use call() from a DO that doesn't know its own binding name. Ensure routeDORequest routes to this DO or incoming calls include metadata.`
        );
      }
      const capturedContext = captureCallContext();
      const localExecutor = doInstance.__localChainExecutor;
      const executeHandler = createHandlerExecutor(localExecutor, capturedContext);
      const callPromise = capturedContext ? runWithCallContext(capturedContext, () => this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options)) : this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options);
      setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
    }
  };
}
function createLmzApiForWorker(env, workerInstance) {
  let storedBindingName = void 0;
  return {
    // --- Getters (all readonly) ---
    get bindingName() {
      return storedBindingName;
    },
    get instanceName() {
      return void 0;
    },
    get type() {
      return "LumenizeWorker";
    },
    get callContext() {
      const context = getCurrentCallContext();
      if (!context) {
        throw new Error(
          "Cannot access callContext outside of a mesh call. callContext is only available during @mesh handler execution."
        );
      }
      return context;
    },
    // --- Internal init method (called by envelope processing) ---
    /**
     * @internal Initialize identity - not for external use
     */
    __init(options) {
      if (options.bindingName !== void 0) {
        if (storedBindingName !== void 0 && storedBindingName !== options.bindingName) {
          throw new Error(
            `Worker binding name mismatch: stored '${storedBindingName}' but received '${options.bindingName}'. A Worker instance cannot change its binding name.`
          );
        }
        storedBindingName = options.bindingName;
      }
    },
    async callRaw(calleeBindingName, calleeInstanceName, chainOrContinuation, options) {
      const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;
      const callerIdentity = {
        type: this.type,
        bindingName: this.bindingName,
        instanceName: void 0
        // Workers don't have instance names
      };
      const calleeType = calleeInstanceName ? "LumenizeDO" : "LumenizeWorker";
      const callContext = buildOutgoingCallContext(callerIdentity, options);
      const metadata = {
        caller: {
          type: this.type,
          bindingName: this.bindingName,
          instanceName: this.instanceName
        },
        callee: {
          type: calleeType,
          bindingName: calleeBindingName,
          instanceName: calleeInstanceName
        }
      };
      const envelope = {
        version: 1,
        chain: preprocess(chain),
        callContext,
        metadata
      };
      let stub;
      if (calleeType === "LumenizeDO") {
        stub = getDOStub(env[calleeBindingName], calleeInstanceName);
      } else {
        stub = env[calleeBindingName];
      }
      const response = await stub.__executeOperation(envelope);
      if (response && "$error" in response) {
        throw postprocess(response.$error);
      }
      return response?.$result;
    },
    call(calleeBindingName, calleeInstanceName, remoteContinuation, handlerContinuation, options) {
      const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);
      if (!this.bindingName) {
        throw new Error(
          `Cannot use call() from a Worker that doesn't know its own binding name. Ensure incoming calls include metadata or call this.lmz.__init() first.`
        );
      }
      const capturedContext = captureCallContext();
      const localExecutor = workerInstance.__localChainExecutor;
      const executeHandler = createHandlerExecutor(localExecutor, capturedContext);
      const callPromise = capturedContext ? runWithCallContext(capturedContext, () => this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options)) : this.callRaw(calleeBindingName, calleeInstanceName, remoteChain, options);
      const handledPromise = setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
      workerInstance.ctx.waitUntil(handledPromise);
    }
  };
}
async function executeEnvelope(envelope, node, options) {
  const nodeTypeName = options?.nodeTypeName ?? "MeshNode";
  const includeInstanceName = options?.includeInstanceName ?? true;
  if (!envelope.version || envelope.version !== 1) {
    const error = new Error(
      `Unsupported RPC envelope version: ${envelope.version}. This version of ${nodeTypeName} only supports v1 envelopes. Old-style calls without envelopes are no longer supported.`
    );
    options?.onValidationError?.(error, {
      receivedVersion: envelope.version,
      supportedVersion: 1
    });
    throw error;
  }
  if (!envelope.callContext) {
    const error = new Error(
      "Missing callContext in envelope. All mesh calls must include callContext."
    );
    options?.onValidationError?.(error, { envelope });
    throw error;
  }
  if (envelope.metadata?.callee) {
    node.lmz.__init({
      bindingName: envelope.metadata.callee.bindingName,
      instanceName: includeInstanceName ? envelope.metadata.callee.instanceName : void 0
    });
  }
  const operationChain = postprocess(envelope.chain);
  try {
    const result = await runWithCallContext(envelope.callContext, async () => {
      node.onBeforeCall();
      return await node.__executeChain(operationChain);
    });
    return { $result: result };
  } catch (error) {
    return { $error: preprocess(error) };
  }
}

// ../../packages/mesh/src/lumenize-client-gateway.ts
import { DurableObject } from "cloudflare:workers";
var GRACE_PERIOD_MS = 5e3;
var CLIENT_CALL_TIMEOUT_MS = 3e4;
var WS_CLOSE_SUPERSEDED = 4409;
var GatewayMessageType = {
  /** Client initiating a call to a mesh node */
  CALL: "call",
  /** Gateway returning the result of a client-initiated call */
  CALL_RESPONSE: "call_response",
  /** Mesh node calling the client (forwarded by Gateway) */
  INCOMING_CALL: "incoming_call",
  /** Client's response to an incoming call */
  INCOMING_CALL_RESPONSE: "incoming_call_response",
  /** Post-handshake status (sent immediately after connection) */
  CONNECTION_STATUS: "connection_status"
};
var ClientDisconnectedError = class extends Error {
  constructor(message = "Client is not connected", clientInstanceName) {
    super(message);
    this.clientInstanceName = clientInstanceName;
  }
  name = "ClientDisconnectedError";
};
globalThis.ClientDisconnectedError = ClientDisconnectedError;
var LumenizeClientGateway = class extends DurableObject {
  #debugFactory = debug;
  /** Pending calls waiting for client response */
  #pendingCalls = /* @__PURE__ */ new Map();
  /** Waiters for client reconnection during grace period */
  #pendingReconnectWaiters = [];
  /**
   * Handle incoming HTTP requests (primarily WebSocket upgrades)
   */
  async fetch(request) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.fetch");
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      log.warn("WebSocket upgrade rejected: missing Authorization Bearer header");
      return new Response("Unauthorized: missing identity", { status: 401 });
    }
    const jwtToken = authHeader.slice(7);
    let sub;
    let claims;
    let tokenExp;
    try {
      const payloadB64 = jwtToken.split(".")[1];
      const padded = payloadB64 + "=".repeat((4 - payloadB64.length % 4) % 4);
      const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
      sub = payload.sub;
      tokenExp = payload.exp;
      claims = {
        emailVerified: payload.emailVerified,
        adminApproved: payload.adminApproved,
        ...payload.isAdmin ? { isAdmin: payload.isAdmin } : {},
        ...payload.act ? { act: payload.act } : {}
      };
    } catch (e) {
      log.warn("Failed to decode JWT from Authorization header");
      return new Response("Unauthorized: invalid token", { status: 401 });
    }
    if (!sub) {
      log.warn("WebSocket upgrade rejected: JWT missing sub claim");
      return new Response("Unauthorized: missing identity", { status: 401 });
    }
    const instanceName = request.headers.get("X-Lumenize-DO-Instance-Name-Or-Id") ?? void 0;
    if (!instanceName) {
      log.warn("WebSocket upgrade rejected: missing instance name header");
      return new Response("Forbidden: missing instance name", { status: 403 });
    }
    const dotIndex = instanceName.indexOf(".");
    if (dotIndex === -1) {
      log.warn("Invalid instance name format", { instanceName, expected: "{sub}.{tabId}" });
      return new Response("Forbidden: invalid instance name format (expected sub.tabId)", { status: 403 });
    }
    const instanceSub = instanceName.substring(0, dotIndex);
    if (instanceSub !== sub) {
      log.warn("Identity mismatch: sub does not match instance name prefix", {
        sub,
        instanceSub,
        instanceName
      });
      return new Response("Forbidden: identity mismatch", { status: 403 });
    }
    const subscriptionRequired = await this.#isSubscriptionRequired();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment = {
      sub,
      claims,
      tokenExp,
      connectedAt: Date.now(),
      instanceName
    };
    const existingSockets = this.ctx.getWebSockets();
    for (const sock of existingSockets) {
      sock.close(WS_CLOSE_SUPERSEDED, "Superseded by new connection");
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.#resolveReconnectWaiters();
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null) {
      await this.ctx.storage.deleteAlarm();
    }
    const statusMessage = {
      type: GatewayMessageType.CONNECTION_STATUS,
      subscriptionRequired
    };
    server.send(JSON.stringify(statusMessage));
    log.info("WebSocket connection accepted", {
      sub,
      instanceName,
      subscriptionRequired
    });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "Sec-WebSocket-Protocol": "lmz"
      }
    });
  }
  /**
   * Handle incoming WebSocket messages from the client
   */
  async webSocketMessage(ws, message) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.webSocketMessage");
    if (typeof message !== "string") {
      log.warn("Received non-string message, ignoring");
      return;
    }
    const attachment = ws.deserializeAttachment();
    if (attachment?.tokenExp && attachment.tokenExp < Date.now() / 1e3) {
      log.warn("Token expired, closing connection");
      ws.close(4401, "Token expired");
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (e) {
      log.error("Failed to parse message", { error: e });
      return;
    }
    switch (parsed.type) {
      case GatewayMessageType.CALL:
        await this.#handleClientCall(ws, parsed, attachment);
        break;
      case GatewayMessageType.INCOMING_CALL_RESPONSE:
        this.#handleIncomingCallResponse(parsed);
        break;
      default:
        log.warn("Unknown message type", { type: parsed.type });
    }
  }
  /**
   * Handle WebSocket close event
   */
  async webSocketClose(ws, code, reason) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.webSocketClose");
    log.info("WebSocket closed", { code, reason });
    if (code === WS_CLOSE_SUPERSEDED) {
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + GRACE_PERIOD_MS);
  }
  /**
   * Handle WebSocket error event
   */
  async webSocketError(ws, error) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.webSocketError");
    log.error("WebSocket error", { error });
  }
  /**
   * Handle alarm (grace period expired)
   */
  async alarm() {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.alarm");
    log.info("Grace period expired");
    await this.ctx.storage.deleteAlarm();
    this.#rejectReconnectWaiters(new ClientDisconnectedError(
      "Client did not reconnect within grace period",
      this.#getInstanceName()
    ));
  }
  /**
   * Receive and execute an RPC call from a mesh node destined for the client
   *
   * This is called by mesh nodes via: this.lmz.call('LUMENIZE_CLIENT_GATEWAY', clientId, ...)
   */
  async __executeOperation(envelope) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.__executeOperation");
    if (!envelope.version || envelope.version !== 1) {
      return { $error: preprocess(new Error(`Unsupported RPC envelope version: ${envelope.version}`)) };
    }
    let ws = this.#getActiveWebSocket();
    if (!ws) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm !== null && alarm <= Date.now() + GRACE_PERIOD_MS) {
        log.info("Client disconnected, waiting for reconnect during grace period");
        await this.#waitForReconnect();
        ws = this.#getActiveWebSocket();
        if (!ws) {
          return { $error: preprocess(new ClientDisconnectedError(
            "Client did not reconnect in time",
            this.#getInstanceName()
          )) };
        }
      } else {
        return { $error: preprocess(new ClientDisconnectedError(
          "Client is not connected",
          this.#getInstanceName()
        )) };
      }
    }
    const attachment = ws.deserializeAttachment();
    if (attachment?.tokenExp && attachment.tokenExp < Date.now() / 1e3) {
      log.warn("Token expired, closing connection");
      ws.close(4401, "Token expired");
      return { $error: preprocess(new ClientDisconnectedError(
        "Client token expired",
        this.#getInstanceName()
      )) };
    }
    try {
      const result = await this.#forwardToClient(ws, envelope);
      return { $result: result };
    } catch (error) {
      return { $error: preprocess(error) };
    }
  }
  // ============================================
  // Private Methods - Call Handling
  // ============================================
  /**
   * Handle a call from the client to a mesh node
   */
  async #handleClientCall(ws, message, attachment) {
    const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.#handleClientCall");
    const { callId, binding, instance, chain, callContext: clientContext } = message;
    try {
      const verifiedOrigin = {
        type: "LumenizeClient",
        bindingName: "LUMENIZE_CLIENT_GATEWAY",
        // Clients connect through Gateway binding
        instanceName: attachment?.instanceName
      };
      const originAuth = attachment?.sub ? {
        sub: attachment.sub,
        claims: attachment.claims
      } : void 0;
      const clientCallChain = clientContext?.callChain ?? [];
      const callContext = {
        callChain: [verifiedOrigin, ...clientCallChain.slice(1)],
        originAuth,
        state: clientContext?.state ? postprocess(clientContext.state) : {}
      };
      const calleeType = instance ? "LumenizeDO" : "LumenizeWorker";
      const envelope = {
        version: 1,
        chain,
        // Already preprocessed by client - pass through
        callContext,
        metadata: {
          caller: {
            type: "LumenizeClient",
            bindingName: "LUMENIZE_CLIENT_GATEWAY",
            instanceName: attachment?.instanceName
          },
          callee: {
            type: calleeType,
            bindingName: binding,
            instanceName: instance
          }
        }
      };
      let stub;
      if (instance) {
        stub = getDOStub(this.env[binding], instance);
      } else {
        stub = this.env[binding];
      }
      const wrapped = await stub.__executeOperation(envelope);
      if (wrapped && "$error" in wrapped) {
        const response2 = {
          type: GatewayMessageType.CALL_RESPONSE,
          callId,
          success: false,
          error: wrapped.$error
          // Already preprocessed
        };
        ws.send(JSON.stringify(response2));
        return;
      }
      const response = {
        type: GatewayMessageType.CALL_RESPONSE,
        callId,
        success: true,
        result: preprocess(wrapped?.$result)
      };
      ws.send(JSON.stringify(response));
    } catch (error) {
      log.error("Call failed", { callId, binding, instance, error });
      const response = {
        type: GatewayMessageType.CALL_RESPONSE,
        callId,
        success: false,
        error: preprocess(error)
      };
      ws.send(JSON.stringify(response));
    }
  }
  /**
   * Handle a response from the client to an incoming call
   */
  #handleIncomingCallResponse(message) {
    const { callId, success, result, error } = message;
    const pending = this.#pendingCalls.get(callId);
    if (!pending) {
      const log = this.#debugFactory("lmz.mesh.LumenizeClientGateway.#handleIncomingCallResponse");
      log.warn("Received response for unknown call", { callId });
      return;
    }
    clearTimeout(pending.timeout);
    this.#pendingCalls.delete(callId);
    if (success) {
      pending.resolve(postprocess(result));
    } else {
      const deserializedError = postprocess(error);
      pending.reject(deserializedError instanceof Error ? deserializedError : new Error(String(deserializedError)));
    }
  }
  /**
   * Forward a mesh call to the client and wait for response
   */
  async #forwardToClient(ws, envelope) {
    const callId = crypto.randomUUID();
    const message = {
      type: GatewayMessageType.INCOMING_CALL,
      callId,
      chain: envelope.chain,
      // Already preprocessed by caller
      callContext: {
        callChain: envelope.callContext.callChain,
        // Plain strings - no preprocessing
        originAuth: envelope.callContext.originAuth,
        // From JWT - no preprocessing
        state: preprocess(envelope.callContext.state)
        // Native → preprocessed for WebSocket
      }
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingCalls.delete(callId);
        reject(new ClientDisconnectedError(
          "Client call timed out",
          this.#getInstanceName()
        ));
      }, CLIENT_CALL_TIMEOUT_MS);
      this.#pendingCalls.set(callId, { resolve, reject, timeout });
      ws.send(JSON.stringify(message));
    });
  }
  // ============================================
  // Private Methods - Connection State
  // ============================================
  /**
   * Get the active WebSocket connection (if any)
   */
  #getActiveWebSocket() {
    const sockets = this.ctx.getWebSockets();
    return sockets.find((s) => s.readyState === WebSocket.OPEN) ?? null;
  }
  /**
   * Get the instance name of this Gateway DO from the WebSocket attachment
   */
  #getInstanceName() {
    const ws = this.#getActiveWebSocket();
    if (ws) {
      const attachment = ws.deserializeAttachment();
      return attachment?.instanceName;
    }
    return void 0;
  }
  /**
   * Determine if client needs to (re)establish subscriptions
   *
   * Returns false when:
   * - Superseding an existing connection (subscriptions still active)
   * - Reconnecting within the 5-second grace period (alarm pending)
   *
   * Returns true for everything else: fresh connection, reconnect after
   * grace period expired, tab wake-up.
   */
  async #isSubscriptionRequired() {
    if (this.ctx.getWebSockets().length > 0) {
      return false;
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm !== null && alarm <= Date.now() + GRACE_PERIOD_MS) {
      return false;
    }
    return true;
  }
  // ============================================
  // Private Methods - Grace Period
  // ============================================
  /**
   * Wait for client to reconnect during grace period
   */
  async #waitForReconnect() {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) {
      throw new ClientDisconnectedError(
        "Client is not connected and no grace period active",
        this.#getInstanceName()
      );
    }
    const remainingMs = alarm - Date.now();
    if (remainingMs <= 0) {
      throw new ClientDisconnectedError(
        "Client grace period has expired",
        this.#getInstanceName()
      );
    }
    return new Promise((resolve, reject) => {
      this.#pendingReconnectWaiters.push({ resolve, reject });
    });
  }
  /**
   * Resolve all pending reconnect waiters (called when client reconnects)
   */
  #resolveReconnectWaiters() {
    const waiters = this.#pendingReconnectWaiters;
    this.#pendingReconnectWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }
  /**
   * Reject all pending reconnect waiters (called when grace period expires)
   */
  #rejectReconnectWaiters(error) {
    const waiters = this.#pendingReconnectWaiters;
    this.#pendingReconnectWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
};

// ../../packages/mesh/src/sql.ts
function sql(doInstance) {
  const ctx = doInstance.ctx;
  if (!ctx?.storage?.sql) {
    throw new Error("sql() requires a Durable Object instance with ctx.storage.sql");
  }
  return (strings, ...values) => {
    const query = strings.reduce(
      (acc, str, i) => acc + str + (i < values.length ? "?" : ""),
      ""
    );
    return [...ctx.storage.sql.exec(query, ...values)];
  };
}

// ../../node_modules/cron-schedule/dist/utils.js
function extractDateElements(date) {
  return {
    second: date.getSeconds(),
    minute: date.getMinutes(),
    hour: date.getHours(),
    day: date.getDate(),
    month: date.getMonth(),
    weekday: date.getDay(),
    year: date.getFullYear()
  };
}
function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function getDaysBetweenWeekdays(weekday1, weekday2) {
  if (weekday1 <= weekday2) {
    return weekday2 - weekday1;
  }
  return 6 - weekday1 + weekday2 + 1;
}

// ../../node_modules/cron-schedule/dist/cron.js
var Cron = class {
  constructor({ seconds, minutes, hours, days, months, weekdays }) {
    if (!seconds || seconds.size === 0)
      throw new Error("There must be at least one allowed second.");
    if (!minutes || minutes.size === 0)
      throw new Error("There must be at least one allowed minute.");
    if (!hours || hours.size === 0)
      throw new Error("There must be at least one allowed hour.");
    if (!months || months.size === 0)
      throw new Error("There must be at least one allowed month.");
    if ((!weekdays || weekdays.size === 0) && (!days || days.size === 0))
      throw new Error("There must be at least one allowed day or weekday.");
    this.seconds = Array.from(seconds).sort((a, b) => a - b);
    this.minutes = Array.from(minutes).sort((a, b) => a - b);
    this.hours = Array.from(hours).sort((a, b) => a - b);
    this.days = Array.from(days).sort((a, b) => a - b);
    this.months = Array.from(months).sort((a, b) => a - b);
    this.weekdays = Array.from(weekdays).sort((a, b) => a - b);
    const validateData = (name, data, constraint) => {
      if (data.some((x) => typeof x !== "number" || x % 1 !== 0 || x < constraint.min || x > constraint.max)) {
        throw new Error(`${name} must only consist of integers which are within the range of ${constraint.min} and ${constraint.max}`);
      }
    };
    validateData("seconds", this.seconds, { min: 0, max: 59 });
    validateData("minutes", this.minutes, { min: 0, max: 59 });
    validateData("hours", this.hours, { min: 0, max: 23 });
    validateData("days", this.days, { min: 1, max: 31 });
    validateData("months", this.months, { min: 0, max: 11 });
    validateData("weekdays", this.weekdays, { min: 0, max: 6 });
    this.reversed = {
      seconds: this.seconds.map((x) => x).reverse(),
      minutes: this.minutes.map((x) => x).reverse(),
      hours: this.hours.map((x) => x).reverse(),
      days: this.days.map((x) => x).reverse(),
      months: this.months.map((x) => x).reverse(),
      weekdays: this.weekdays.map((x) => x).reverse()
    };
  }
  /**
   * Find the next or previous hour, starting from the given start hour that matches the hour constraint.
   * startHour itself might also be allowed.
   */
  findAllowedHour(dir, startHour) {
    return dir === "next" ? this.hours.find((x) => x >= startHour) : this.reversed.hours.find((x) => x <= startHour);
  }
  /**
   * Find the next or previous minute, starting from the given start minute that matches the minute constraint.
   * startMinute itself might also be allowed.
   */
  findAllowedMinute(dir, startMinute) {
    return dir === "next" ? this.minutes.find((x) => x >= startMinute) : this.reversed.minutes.find((x) => x <= startMinute);
  }
  /**
   * Find the next or previous second, starting from the given start second that matches the second constraint.
   * startSecond itself IS NOT allowed.
   */
  findAllowedSecond(dir, startSecond) {
    return dir === "next" ? this.seconds.find((x) => x > startSecond) : this.reversed.seconds.find((x) => x < startSecond);
  }
  /**
   * Find the next or previous time, starting from the given start time that matches the hour, minute
   * and second constraints. startTime itself might also be allowed.
   */
  findAllowedTime(dir, startTime) {
    let hour = this.findAllowedHour(dir, startTime.hour);
    if (hour !== void 0) {
      if (hour === startTime.hour) {
        let minute = this.findAllowedMinute(dir, startTime.minute);
        if (minute !== void 0) {
          if (minute === startTime.minute) {
            const second = this.findAllowedSecond(dir, startTime.second);
            if (second !== void 0) {
              return { hour, minute, second };
            }
            minute = this.findAllowedMinute(dir, dir === "next" ? startTime.minute + 1 : startTime.minute - 1);
            if (minute !== void 0) {
              return {
                hour,
                minute,
                second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
              };
            }
          } else {
            return {
              hour,
              minute,
              second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
            };
          }
        }
        hour = this.findAllowedHour(dir, dir === "next" ? startTime.hour + 1 : startTime.hour - 1);
        if (hour !== void 0) {
          return {
            hour,
            minute: dir === "next" ? this.minutes[0] : this.reversed.minutes[0],
            second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
          };
        }
      } else {
        return {
          hour,
          minute: dir === "next" ? this.minutes[0] : this.reversed.minutes[0],
          second: dir === "next" ? this.seconds[0] : this.reversed.seconds[0]
        };
      }
    }
    return void 0;
  }
  /**
   * Find the next or previous day in the given month, starting from the given startDay
   * that matches either the day or the weekday constraint. startDay itself might also be allowed.
   */
  findAllowedDayInMonth(dir, year, month, startDay) {
    var _a, _b;
    if (startDay < 1)
      throw new Error("startDay must not be smaller than 1.");
    const daysInMonth = getDaysInMonth(year, month);
    const daysRestricted = this.days.length !== 31;
    const weekdaysRestricted = this.weekdays.length !== 7;
    if (!daysRestricted && !weekdaysRestricted) {
      if (startDay > daysInMonth) {
        return dir === "next" ? void 0 : daysInMonth;
      }
      return startDay;
    }
    let allowedDayByDays;
    if (daysRestricted) {
      allowedDayByDays = dir === "next" ? this.days.find((x) => x >= startDay) : this.reversed.days.find((x) => x <= startDay);
      if (allowedDayByDays !== void 0 && allowedDayByDays > daysInMonth) {
        allowedDayByDays = void 0;
      }
    }
    let allowedDayByWeekdays;
    if (weekdaysRestricted) {
      const startWeekday = new Date(year, month, startDay).getDay();
      const nearestAllowedWeekday = dir === "next" ? (_a = this.weekdays.find((x) => x >= startWeekday)) !== null && _a !== void 0 ? _a : this.weekdays[0] : (_b = this.reversed.weekdays.find((x) => x <= startWeekday)) !== null && _b !== void 0 ? _b : this.reversed.weekdays[0];
      if (nearestAllowedWeekday !== void 0) {
        const daysBetweenWeekdays = dir === "next" ? getDaysBetweenWeekdays(startWeekday, nearestAllowedWeekday) : getDaysBetweenWeekdays(nearestAllowedWeekday, startWeekday);
        allowedDayByWeekdays = dir === "next" ? startDay + daysBetweenWeekdays : startDay - daysBetweenWeekdays;
        if (allowedDayByWeekdays > daysInMonth || allowedDayByWeekdays < 1) {
          allowedDayByWeekdays = void 0;
        }
      }
    }
    if (allowedDayByDays !== void 0 && allowedDayByWeekdays !== void 0) {
      return dir === "next" ? Math.min(allowedDayByDays, allowedDayByWeekdays) : Math.max(allowedDayByDays, allowedDayByWeekdays);
    }
    if (allowedDayByDays !== void 0) {
      return allowedDayByDays;
    }
    if (allowedDayByWeekdays !== void 0) {
      return allowedDayByWeekdays;
    }
    return void 0;
  }
  /** Gets the next date starting from the given start date or now. */
  getNextDate(startDate = /* @__PURE__ */ new Date()) {
    const startDateElements = extractDateElements(startDate);
    let minYear = startDateElements.year;
    let startIndexMonth = this.months.findIndex((x) => x >= startDateElements.month);
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      minYear++;
    }
    const maxIterations = this.months.length * 5;
    for (let i = 0; i < maxIterations; i++) {
      const year = minYear + Math.floor((startIndexMonth + i) / this.months.length);
      const month = this.months[(startIndexMonth + i) % this.months.length];
      const isStartMonth = year === startDateElements.year && month === startDateElements.month;
      let day = this.findAllowedDayInMonth("next", year, month, isStartMonth ? startDateElements.day : 1);
      let isStartDay = isStartMonth && day === startDateElements.day;
      if (day !== void 0 && isStartDay) {
        const nextTime = this.findAllowedTime("next", startDateElements);
        if (nextTime !== void 0) {
          return new Date(year, month, day, nextTime.hour, nextTime.minute, nextTime.second);
        }
        day = this.findAllowedDayInMonth("next", year, month, day + 1);
        isStartDay = false;
      }
      if (day !== void 0 && !isStartDay) {
        return new Date(year, month, day, this.hours[0], this.minutes[0], this.seconds[0]);
      }
    }
    throw new Error("No valid next date was found.");
  }
  /** Gets the specified amount of future dates starting from the given start date or now. */
  getNextDates(amount, startDate) {
    const dates = [];
    let nextDate;
    for (let i = 0; i < amount; i++) {
      nextDate = this.getNextDate(nextDate !== null && nextDate !== void 0 ? nextDate : startDate);
      dates.push(nextDate);
    }
    return dates;
  }
  /**
   * Get an ES6 compatible iterator which iterates over the next dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  *getNextDatesIterator(startDate, endDate) {
    let nextDate;
    while (true) {
      nextDate = this.getNextDate(nextDate !== null && nextDate !== void 0 ? nextDate : startDate);
      if (endDate && endDate.getTime() < nextDate.getTime()) {
        return;
      }
      yield nextDate;
    }
  }
  /** Gets the previous date starting from the given start date or now. */
  getPrevDate(startDate = /* @__PURE__ */ new Date()) {
    const startDateElements = extractDateElements(startDate);
    let maxYear = startDateElements.year;
    let startIndexMonth = this.reversed.months.findIndex((x) => x <= startDateElements.month);
    if (startIndexMonth === -1) {
      startIndexMonth = 0;
      maxYear--;
    }
    const maxIterations = this.reversed.months.length * 5;
    for (let i = 0; i < maxIterations; i++) {
      const year = maxYear - Math.floor((startIndexMonth + i) / this.reversed.months.length);
      const month = this.reversed.months[(startIndexMonth + i) % this.reversed.months.length];
      const isStartMonth = year === startDateElements.year && month === startDateElements.month;
      let day = this.findAllowedDayInMonth("prev", year, month, isStartMonth ? startDateElements.day : (
        // Start searching from the last day of the month.
        getDaysInMonth(year, month)
      ));
      let isStartDay = isStartMonth && day === startDateElements.day;
      if (day !== void 0 && isStartDay) {
        const prevTime = this.findAllowedTime("prev", startDateElements);
        if (prevTime !== void 0) {
          return new Date(year, month, day, prevTime.hour, prevTime.minute, prevTime.second);
        }
        if (day > 1) {
          day = this.findAllowedDayInMonth("prev", year, month, day - 1);
          isStartDay = false;
        }
      }
      if (day !== void 0 && !isStartDay) {
        return new Date(year, month, day, this.reversed.hours[0], this.reversed.minutes[0], this.reversed.seconds[0]);
      }
    }
    throw new Error("No valid previous date was found.");
  }
  /** Gets the specified amount of previous dates starting from the given start date or now. */
  getPrevDates(amount, startDate) {
    const dates = [];
    let prevDate;
    for (let i = 0; i < amount; i++) {
      prevDate = this.getPrevDate(prevDate !== null && prevDate !== void 0 ? prevDate : startDate);
      dates.push(prevDate);
    }
    return dates;
  }
  /**
   * Get an ES6 compatible iterator which iterates over the previous dates starting from startDate or now.
   * The iterator runs until the optional endDate is reached or forever.
   */
  *getPrevDatesIterator(startDate, endDate) {
    let prevDate;
    while (true) {
      prevDate = this.getPrevDate(prevDate !== null && prevDate !== void 0 ? prevDate : startDate);
      if (endDate && endDate.getTime() > prevDate.getTime()) {
        return;
      }
      yield prevDate;
    }
  }
  /** Returns true when there is a cron date at the given date. */
  matchDate(date) {
    const { second, minute, hour, day, month, weekday } = extractDateElements(date);
    if (this.seconds.indexOf(second) === -1 || this.minutes.indexOf(minute) === -1 || this.hours.indexOf(hour) === -1 || this.months.indexOf(month) === -1) {
      return false;
    }
    if (this.days.length !== 31 && this.weekdays.length !== 7) {
      return this.days.indexOf(day) !== -1 || this.weekdays.indexOf(weekday) !== -1;
    }
    return this.days.indexOf(day) !== -1 && this.weekdays.indexOf(weekday) !== -1;
  }
};

// ../../node_modules/cron-schedule/dist/cron-parser.js
var secondConstraint = {
  min: 0,
  max: 59
};
var minuteConstraint = {
  min: 0,
  max: 59
};
var hourConstraint = {
  min: 0,
  max: 23
};
var dayConstraint = {
  min: 1,
  max: 31
};
var monthConstraint = {
  min: 1,
  max: 12,
  aliases: {
    jan: "1",
    feb: "2",
    mar: "3",
    apr: "4",
    may: "5",
    jun: "6",
    jul: "7",
    aug: "8",
    sep: "9",
    oct: "10",
    nov: "11",
    dec: "12"
  }
};
var weekdayConstraint = {
  min: 0,
  max: 7,
  aliases: {
    mon: "1",
    tue: "2",
    wed: "3",
    thu: "4",
    fri: "5",
    sat: "6",
    sun: "7"
  }
};
var timeNicknames = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@hourly": "0 * * * *",
  "@minutely": "* * * * *"
};
function parseElement(element, constraint) {
  const result = /* @__PURE__ */ new Set();
  if (element === "*") {
    for (let i = constraint.min; i <= constraint.max; i = i + 1) {
      result.add(i);
    }
    return result;
  }
  const listElements = element.split(",");
  if (listElements.length > 1) {
    for (const listElement of listElements) {
      const parsedListElement = parseElement(listElement, constraint);
      for (const x of parsedListElement) {
        result.add(x);
      }
    }
    return result;
  }
  const parseSingleElement = (singleElement) => {
    var _a, _b;
    singleElement = (_b = (_a = constraint.aliases) === null || _a === void 0 ? void 0 : _a[singleElement.toLowerCase()]) !== null && _b !== void 0 ? _b : singleElement;
    const parsedElement = Number.parseInt(singleElement, 10);
    if (Number.isNaN(parsedElement)) {
      throw new Error(`Failed to parse ${element}: ${singleElement} is NaN.`);
    }
    if (parsedElement < constraint.min || parsedElement > constraint.max) {
      throw new Error(`Failed to parse ${element}: ${singleElement} is outside of constraint range of ${constraint.min} - ${constraint.max}.`);
    }
    return parsedElement;
  };
  const rangeSegments = /^(([0-9a-zA-Z]+)-([0-9a-zA-Z]+)|\*)(\/([0-9]+))?$/.exec(element);
  if (rangeSegments === null) {
    result.add(parseSingleElement(element));
    return result;
  }
  let parsedStart = rangeSegments[1] === "*" ? constraint.min : parseSingleElement(rangeSegments[2]);
  const parsedEnd = rangeSegments[1] === "*" ? constraint.max : parseSingleElement(rangeSegments[3]);
  if (constraint === weekdayConstraint && parsedStart === 7 && // this check ensures that sun-sun is not incorrectly parsed as [0,1,2,3,4,5,6]
  parsedEnd !== 7) {
    parsedStart = 0;
  }
  if (parsedStart > parsedEnd) {
    throw new Error(`Failed to parse ${element}: Invalid range (start: ${parsedStart}, end: ${parsedEnd}).`);
  }
  const step = rangeSegments[5];
  let parsedStep = 1;
  if (step !== void 0) {
    parsedStep = Number.parseInt(step, 10);
    if (Number.isNaN(parsedStep)) {
      throw new Error(`Failed to parse step: ${step} is NaN.`);
    }
    if (parsedStep < 1) {
      throw new Error(`Failed to parse step: Expected ${step} to be greater than 0.`);
    }
  }
  for (let i = parsedStart; i <= parsedEnd; i = i + parsedStep) {
    result.add(i);
  }
  return result;
}
function parseCronExpression(cronExpression) {
  var _a;
  if (typeof cronExpression !== "string") {
    throw new TypeError("Invalid cron expression: must be of type string.");
  }
  cronExpression = (_a = timeNicknames[cronExpression.toLowerCase()]) !== null && _a !== void 0 ? _a : cronExpression;
  const elements = cronExpression.split(" ").filter((elem) => elem.length > 0);
  if (elements.length < 5 || elements.length > 6) {
    throw new Error("Invalid cron expression: expected 5 or 6 elements.");
  }
  const rawSeconds = elements.length === 6 ? elements[0] : "0";
  const rawMinutes = elements.length === 6 ? elements[1] : elements[0];
  const rawHours = elements.length === 6 ? elements[2] : elements[1];
  const rawDays = elements.length === 6 ? elements[3] : elements[2];
  const rawMonths = elements.length === 6 ? elements[4] : elements[3];
  const rawWeekdays = elements.length === 6 ? elements[5] : elements[4];
  return new Cron({
    seconds: parseElement(rawSeconds, secondConstraint),
    minutes: parseElement(rawMinutes, minuteConstraint),
    hours: parseElement(rawHours, hourConstraint),
    days: parseElement(rawDays, dayConstraint),
    // months in cron are indexed by 1, but Cron expects indexes by 0, so we need to reduce all set values by one.
    months: new Set(Array.from(parseElement(rawMonths, monthConstraint)).map((x) => x - 1)),
    weekdays: new Set(Array.from(parseElement(rawWeekdays, weekdayConstraint)).map((x) => x % 7))
  });
}

// ../../packages/mesh/src/alarms.ts
var import_ulid_workers = __toESM(require_dist(), 1);
var ulid = (0, import_ulid_workers.ulidFactory)({ monotonic: true });
function getNextCronTime(cron) {
  const interval = parseCronExpression(cron);
  return interval.getNextDate();
}
var Alarms = class {
  #doInstance;
  #sql;
  #storage;
  #log;
  constructor(doInstance) {
    this.#doInstance = doInstance;
    this.#storage = doInstance.ctx.storage;
    if (!doInstance.svc.sql) {
      throw new Error("Alarms requires sql service (built-in to @lumenize/mesh)");
    }
    this.#sql = doInstance.svc.sql;
    this.#log = debug("lmz.alarms.Alarms");
    this.#storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS __lmz_alarms (
        id TEXT PRIMARY KEY NOT NULL,
        operationChain TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed', 'cron')),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        cron TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `);
  }
  /**
   * Schedule a task to execute in the future.
   * @param when Date, seconds delay, or cron expression
   * @param continuation OCAN chain from `this.ctn()`
   * @see https://lumenize.com/docs/mesh/alarms#scheduling-tasks
   */
  schedule(when, continuation, options) {
    const operationChain = getOperationChain(continuation);
    if (!operationChain) {
      this.#log.error("Invalid continuation passed to schedule", {
        hasContinuation: !!continuation,
        continuationType: typeof continuation
      });
      throw new Error("Invalid continuation: must be created with newContinuation() or this.ctn()");
    }
    const id = options?.id ?? ulid();
    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1e3);
      this.#log.debug("Scheduling alarm", {
        id,
        firesAt: when.toISOString(),
        timestamp,
        operationName: operationChain[0]?.type === "get" ? String(operationChain[0].key) : void 0
      });
      this.#storeSchedule(id, operationChain, "scheduled", timestamp, {});
      this.#log.debug("Alarm stored and next alarm scheduled", { id, timestamp });
      this.#scheduleNextAlarm();
      return {
        id,
        operationChain,
        time: timestamp,
        type: "scheduled"
      };
    }
    if (typeof when === "number") {
      const time = new Date(Date.now() + when * 1e3);
      const timestamp = Math.floor(time.getTime() / 1e3);
      this.#storeSchedule(id, operationChain, "delayed", timestamp, { delayInSeconds: when });
      this.#scheduleNextAlarm();
      return {
        id,
        operationChain,
        delayInSeconds: when,
        time: timestamp,
        type: "delayed"
      };
    }
    if (typeof when === "string") {
      const nextExecutionTime = getNextCronTime(when);
      const timestamp = Math.floor(nextExecutionTime.getTime() / 1e3);
      this.#storeSchedule(id, operationChain, "cron", timestamp, { cron: when });
      this.#scheduleNextAlarm();
      return {
        id,
        operationChain,
        cron: when,
        time: timestamp,
        type: "cron"
      };
    }
    throw new Error("Invalid schedule type");
  }
  #storeSchedule(id, operationChain, type, time, extra) {
    const serialized = JSON.stringify(preprocess(operationChain));
    if (type === "scheduled") {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, time)
        VALUES (${id}, ${serialized}, ${type}, ${time})
      `;
    } else if (type === "delayed") {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, delayInSeconds, time)
        VALUES (${id}, ${serialized}, ${type}, ${extra.delayInSeconds}, ${time})
      `;
    } else if (type === "cron") {
      this.#sql`
        INSERT OR REPLACE INTO __lmz_alarms (id, operationChain, type, cron, time)
        VALUES (${id}, ${serialized}, ${type}, ${extra.cron}, ${time})
      `;
    }
  }
  /**
   * Get a scheduled task by ID
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  getSchedule(id) {
    const result = this.#sql`SELECT * FROM __lmz_alarms WHERE id = ${id}`;
    if (result.length === 0) return void 0;
    return { ...result[0], operationChain: parse(result[0].operationChain) };
  }
  /**
   * Get scheduled tasks matching the given criteria
   * @param criteria Criteria to filter schedules
   * @returns Array of matching Schedule objects
   */
  getSchedules(criteria = {}) {
    let query = "SELECT * FROM __lmz_alarms WHERE 1=1";
    const params = [];
    if (criteria.id) {
      query += " AND id = ?";
      params.push(criteria.id);
    }
    if (criteria.type) {
      query += " AND type = ?";
      params.push(criteria.type);
    }
    if (criteria.timeRange) {
      query += " AND time >= ? AND time <= ?";
      const start = criteria.timeRange.start || /* @__PURE__ */ new Date(0);
      const end = criteria.timeRange.end || /* @__PURE__ */ new Date(999999999999999);
      params.push(
        Math.floor(start.getTime() / 1e3),
        Math.floor(end.getTime() / 1e3)
      );
    }
    const result = [...this.#storage.sql.exec(query, ...params)];
    const schedules = result.map((row) => ({
      ...row,
      operationChain: parse(row.operationChain)
    }));
    return schedules;
  }
  /**
   * Cancel a scheduled task
   * @param id ID of the task to cancel
   * @returns The cancelled Schedule with its continuation data, or undefined if not found
   */
  cancelSchedule(id) {
    const result = this.#sql`SELECT * FROM __lmz_alarms WHERE id = ${id}`;
    if (result.length === 0) return void 0;
    this.#storage.sql.exec(`DELETE FROM __lmz_alarms WHERE id = ?`, id);
    this.#scheduleNextAlarm();
    return { ...result[0], operationChain: parse(result[0].operationChain) };
  }
  /**
   * Execute pending alarms. Used internally by `alarm()` and for testing.
   * @param count Alarms to execute (default: all overdue)
   * @see https://lumenize.com/docs/mesh/alarms#testing
   */
  async triggerAlarms(count) {
    const now = Math.floor(Date.now() / 1e3);
    const executedIds = [];
    let effectiveCount;
    if (count === void 0) {
      const overdueResult = this.#sql`SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}`;
      effectiveCount = overdueResult[0]?.count ?? 1;
    } else {
      effectiveCount = count;
    }
    for (let i = 0; i < effectiveCount; i++) {
      const result = this.#sql`SELECT * FROM __lmz_alarms ORDER BY time ASC, id ASC LIMIT 1`;
      if (result.length === 0) break;
      const row = result[0];
      try {
        const executor = this.#doInstance.__localChainExecutor;
        await executor(parse(row.operationChain), { requireMeshDecorator: false });
        executedIds.push(row.id);
      } catch (e) {
        this.#log.error("Error executing alarm", {
          id: row.id,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : void 0
        });
      }
      if (row.type === "cron") {
        const nextTimestamp = Math.floor(getNextCronTime(row.cron).getTime() / 1e3);
        this.#sql`UPDATE __lmz_alarms SET time = ${nextTimestamp} WHERE id = ${row.id}`;
      } else {
        this.#sql`DELETE FROM __lmz_alarms WHERE id = ${row.id}`;
      }
    }
    this.#scheduleNextAlarm();
    return executedIds;
  }
  /** Alarm handler - called by LumenizeDO's alarm() lifecycle method */
  alarm = async (alarmInfo) => {
    const now = Math.floor(Date.now() / 1e3);
    const overdueResult = this.#sql`SELECT COUNT(*) as count FROM __lmz_alarms WHERE time <= ${now}`;
    const overdueCount = overdueResult[0]?.count || 0;
    if (overdueCount > 0) {
      await this.triggerAlarms(overdueCount);
    }
  };
  #scheduleNextAlarm() {
    const result = this.#sql`
      SELECT time FROM __lmz_alarms WHERE time > ${Math.floor(Date.now() / 1e3)}
      ORDER BY time ASC, id ASC LIMIT 1
    `;
    if (result.length > 0) {
      this.#storage.setAlarm(result[0].time * 1e3);
    }
  }
};

// ../../packages/mesh/src/lumenize-do.ts
globalThis.ClientDisconnectedError = ClientDisconnectedError;
var LumenizeDO = class _LumenizeDO extends DurableObject2 {
  #serviceCache = /* @__PURE__ */ new Map();
  #svcProxy = null;
  #lmzApi = null;
  constructor(ctx, env) {
    super(ctx, env);
    if (this.onStart !== _LumenizeDO.prototype.onStart) {
      ctx.blockConcurrencyWhile(async () => {
        try {
          await this.onStart();
        } catch (error) {
          const log = debug("lmz.mesh.LumenizeDO.onStart");
          log.error("onStart() failed", {
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : void 0
          });
          throw error;
        }
      });
    }
  }
  /**
   * Lifecycle hook for async initialization
   *
   * Override this method to perform initialization that needs to complete
   * before the DO handles any requests. Common uses:
   * - Database schema migrations (`CREATE TABLE IF NOT EXISTS`)
   * - Loading configuration from storage
   * - Setting up initial state
   *
   * This method is automatically wrapped in `blockConcurrencyWhile`, ensuring
   * it completes before fetch(), alarm(), or any RPC calls are processed.
   *
   * @example
   * ```typescript
   * class UsersDO extends LumenizeDO<Env> {
   *   async onStart() {
   *     this.svc.sql`
   *       CREATE TABLE IF NOT EXISTS users (
   *         id TEXT PRIMARY KEY,
   *         name TEXT NOT NULL
   *       )
   *     `;
   *   }
   * }
   * ```
   */
  async onStart() {
  }
  /**
   * Alarm lifecycle handler - delegates to built-in alarms service
   *
   * This method is called by Cloudflare when a scheduled alarm fires.
   * It automatically delegates to `this.svc.alarms.alarm()` to execute
   * any pending scheduled tasks.
   *
   * **No override needed** - LumenizeDO handles alarm scheduling automatically.
   * Just use `this.svc.alarms.schedule()` to schedule tasks.
   *
   * @param alarmInfo - Cloudflare alarm invocation info
   *
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
   *   scheduleTask() {
   *     // Schedule a task - alarm() handles execution automatically
   *     this.svc.alarms.schedule(60, this.ctn().handleTask({ data: 'example' }));
   *   }
   *
   *   handleTask(payload: { data: string }) {
   *     console.log('Task executed:', payload);
   *   }
   * }
   * ```
   */
  async alarm(alarmInfo) {
    await this.svc.alarms.alarm(alarmInfo);
  }
  /**
   * Lifecycle hook called before each incoming mesh call is executed
   *
   * Override this method to:
   * - Validate authentication/authorization based on `this.lmz.callContext`
   * - Populate `callContext.state` with computed data (sessions, permissions)
   * - Add logging or tracing metadata
   * - Reject unauthorized calls by throwing an error
   *
   * This hook is called AFTER the DO is initialized and BEFORE the operation
   * chain is executed. The `callContext` is available via `this.lmz.callContext`.
   *
   * **Important**: If you override this, remember to call `super.onBeforeCall()`
   * to ensure any parent class logic is also executed.
   *
   * @example
   * ```typescript
   * class SecureDocumentDO extends LumenizeDO<Env> {
   *   onBeforeCall(): void {
   *     super.onBeforeCall();
   *
   *     const { origin, originAuth, state } = this.lmz.callContext;
   *
   *     // Require authenticated origin for client calls
   *     if (origin.type === 'LumenizeClient' && !originAuth?.sub) {
   *       throw new Error('Authentication required');
   *     }
   *
   *     // Cache computed permissions in state (synchronously)
   *     state.canEdit = this.#permissions.get(originAuth?.sub);
   *   }
   * }
   * ```
   */
  onBeforeCall() {
  }
  /**
   * Default fetch handler that auto-initializes DO metadata from headers
   * 
   * This handler automatically reads `x-lumenize-do-binding-name` and
   * `x-lumenize-do-instance-name-or-id` headers (set by routeDORequest)
   * and stores them for use by this.lmz.call() and other services.
   * 
   * Subclasses should call `super.fetch(request)` at the start of their
   * fetch handler to enable auto-initialization:
   * 
   * @param request - The incoming HTTP request
   * @returns HTTP 501 Not Implemented (subclasses should override)
   * 
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
   *   async fetch(request: Request) {
   *     // Auto-initialize from headers
   *     await super.fetch(request);
   *     
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  async fetch(request) {
    const initError = this.__initFromHeaders(request.headers);
    if (initError) {
      return initError;
    }
    return new Response("Not Implemented", { status: 501 });
  }
  /**
   * Initialize DO metadata from request headers
   *
   * Reads `x-lumenize-do-binding-name` and `x-lumenize-do-instance-name-or-id`
   * headers and calls `this.lmz.__init()` if present. These headers are automatically
   * set by `routeDORequest` in @lumenize/routing.
   *
   * **Validation**: If the instance header contains a Durable Object ID (64-char hex string)
   * instead of a name, returns an HTTP 400 error. LumenizeDO requires instance names for
   * proper mesh addressing.
   *
   * This is called automatically by the default `fetch()` handler. If you
   * override `fetch()` and don't call `super.fetch()`, you can call this
   * method directly:
   *
   * @param headers - HTTP headers from the request
   * @returns Response with HTTP 400 error if validation fails, undefined on success
   *
   * @example
   * ```typescript
   * class MyDO extends LumenizeDO<Env> {
   *   async fetch(request: Request) {
   *     // Manual initialization (alternative to super.fetch())
   *     const error = this.__initFromHeaders(request.headers);
   *     if (error) return error;
   *
   *     // Handle request
   *     return new Response('Hello');
   *   }
   * }
   * ```
   */
  __initFromHeaders(headers) {
    const doBindingName = headers.get("x-lumenize-do-binding-name");
    const doInstanceNameOrId = headers.get("x-lumenize-do-instance-name-or-id");
    if (doInstanceNameOrId && isDurableObjectId(doInstanceNameOrId)) {
      const log = debug("lmz.mesh.LumenizeDO.__initFromHeaders");
      const message = "LumenizeDO requires instanceName, not a DO id string.";
      log.error(message, { receivedValue: doInstanceNameOrId });
      return new Response(message, { status: 400 });
    }
    if (doBindingName || doInstanceNameOrId) {
      try {
        this.lmz.__init({
          bindingName: doBindingName || void 0,
          instanceName: doInstanceNameOrId || void 0
        });
      } catch (error) {
        const log = debug("lmz.mesh.LumenizeDO.__initFromHeaders");
        const message = error instanceof Error ? error.message : String(error);
        log.error("Initialization from headers failed", {
          error: message,
          stack: error instanceof Error ? error.stack : void 0
        });
        return new Response(message, { status: 500 });
      }
    }
    return void 0;
  }
  ctn() {
    return newContinuation();
  }
  /**
   * Execute an OCAN (Operation Chaining And Nesting) operation chain on this DO.
   *
   * This method enables remote DOs to call methods on this DO via this.lmz.call().
   * Any DO extending LumenizeDO can receive remote calls without additional setup.
   *
   * **Security**: This method always enforces @mesh decorator requirement for
   * incoming calls. The options parameter is intentionally not exposed - use the
   * private `#executeChainLocal()` method for internal calls that need to bypass
   * the @mesh check.
   *
   * @internal This is called by this.lmz.call(), not meant for direct use
   * @param chain - The operation chain to execute
   * @returns The result of executing the operation chain
   *
   * @example
   * ```typescript
   * // Remote DO sends this chain:
   * const remote = this.ctn<MyDO>().getUserData(userId);
   *
   * // This DO receives and executes it:
   * const result = await this.__executeChain(remote);
   * // Equivalent to: this.getUserData(userId)
   * ```
   */
  async __executeChain(chain) {
    return await executeOperationChain(chain, this);
  }
  /**
   * Execute an operation chain locally with configurable options
   *
   * This is a TRUE PRIVATE method (using #) so it cannot be called via RPC.
   * Used by internal services that need to execute continuations without
   * requiring @mesh decorator:
   * - Alarms service (local timer callbacks)
   * - lmz.call() handler callbacks
   *
   * @param chain - The operation chain to execute
   * @param options - Configuration options
   * @returns The result of executing the operation chain
   */
  #executeChainLocal(chain, options) {
    return executeOperationChain(chain, this, options);
  }
  /**
   * Get the local chain executor for internal use
   *
   * This method provides access to the private #executeChainLocal method
   * for trusted internal code (like lmz.call() handlers and alarms).
   *
   * **Security**: This returns a function bound to this instance. The returned
   * function can bypass @mesh checks, but the method itself just returns a
   * function reference - it doesn't execute anything. Attackers calling this
   * via RPC would get a function they can't actually use (it won't serialize
   * over RPC boundaries).
   *
   * @internal
   */
  get __localChainExecutor() {
    return this.#executeChainLocal.bind(this);
  }
  /**
   * Receive and execute an RPC call envelope with auto-initialization
   * 
   * Handles versioned envelopes and automatically initializes this DO's identity
   * from the callee metadata included in the envelope. This enables DOs to learn
   * their binding name and instance name from the first incoming call.
   * 
   * **Envelope format**:
   * - `version: 1` - Current envelope version (required)
   * - `chain` - Preprocessed operation chain to execute
   * - `metadata.callee` - Identity of this DO (used for auto-initialization)
   * 
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param envelope - The call envelope with version, chain, and metadata
   * @returns The result of executing the operation chain
   * @throws Error if envelope version is not 1
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  async __executeOperation(envelope) {
    const log = debug("lmz.mesh.LumenizeDO.__executeOperation");
    return await executeEnvelope(envelope, this, {
      nodeTypeName: "LumenizeDO",
      includeInstanceName: true,
      onValidationError: (error, details) => {
        log.error(error.message.split(".")[0], details);
      }
    });
  }
  /**
   * Access Lumenize infrastructure: identity and RPC methods
   *
   * Provides clean abstraction over identity management and RPC infrastructure:
   * - **Identity**: `bindingName`, `instanceName`, `id`, `type`
   * - **RPC**: `callRaw()`, `call()`
   *
   * Properties are read-only getters that read from DO storage.
   * Identity is set automatically via headers from `routeDORequest` or
   * from the envelope metadata when receiving mesh calls.
   *
   * @see [Usage Examples](https://lumenize.com/docs/mesh/calls) - Complete tested examples
   */
  get lmz() {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForDO(this.ctx, this.env, this);
    }
    return this.#lmzApi;
  }
  /**
   * Access NADIS services via this.svc.*
   * 
   * Services are auto-discovered from the global LumenizeServices interface
   * and lazily instantiated on first access.
   */
  get svc() {
    if (this.#svcProxy) {
      return this.#svcProxy;
    }
    this.#svcProxy = new Proxy({}, {
      get: (_target, prop) => {
        if (this.#serviceCache.has(prop)) {
          return this.#serviceCache.get(prop);
        }
        const service = this.#resolveService(prop);
        if (service) {
          this.#serviceCache.set(prop, service);
          return service;
        }
        const log = debug("lmz.mesh.LumenizeDO.svc");
        const error = new Error(
          `Service '${prop}' not found. Did you import the NADIS package? Example: import '@lumenize/${prop}';`
        );
        log.error("NADIS service not found", {
          service: prop,
          hint: `import '@lumenize/${prop}';`
        });
        throw error;
      }
    });
    return this.#svcProxy;
  }
  /**
   * Resolve a service by name from the global registry
   * 
   * Handles both stateless (functions) and stateful (classes) services:
   * - Stateless: Call function with `this` (e.g., sql(this))
   * - Stateful: Instantiate class with ctx, this, and dependencies
   */
  #resolveService(name) {
    const registry = globalThis.__lumenizeServiceRegistry;
    if (!registry) {
      return null;
    }
    const serviceFactory = registry[name];
    if (!serviceFactory) {
      return null;
    }
    return serviceFactory(this);
  }
};
if (!globalThis.__lumenizeServiceRegistry) {
  globalThis.__lumenizeServiceRegistry = {};
}
if (!globalThis.__lumenizeWorkHandlers) {
  globalThis.__lumenizeWorkHandlers = {};
}
if (!globalThis.__lumenizeResultHandlers) {
  globalThis.__lumenizeResultHandlers = {};
}
globalThis.__LumenizeDOPrototype = LumenizeDO.prototype;
globalThis.__lumenizeServiceRegistry["sql"] = (doInstance) => sql(doInstance);
globalThis.__lumenizeServiceRegistry["alarms"] = (doInstance) => new Alarms(doInstance);

// ../../packages/mesh/src/lumenize-worker.ts
import { WorkerEntrypoint } from "cloudflare:workers";
globalThis.ClientDisconnectedError = ClientDisconnectedError;
var LumenizeWorker = class extends WorkerEntrypoint {
  #lmzApi = null;
  /**
   * Access Lumenize infrastructure: identity and RPC methods
   *
   * Provides clean abstraction over identity management and RPC infrastructure:
   * - **Identity**: `bindingName`, `type` (instanceName/id always undefined for Workers)
   * - **RPC**: `callRaw()`, `call()`
   *
   * Properties use closure storage (no persistence across requests).
   * Identity is set automatically from envelope metadata when receiving mesh calls.
   *
   * @see [Usage Examples](https://lumenize.com/docs/mesh/calls) - Complete tested examples
   */
  get lmz() {
    if (!this.#lmzApi) {
      this.#lmzApi = createLmzApiForWorker(this.env, this);
    }
    return this.#lmzApi;
  }
  /**
   * Create a continuation for method chaining
   * 
   * Continuations enable building method chains that can be:
   * - Executed remotely via RPC
   * - Passed as parameters to other methods
   * - Used with nested operation markers for result substitution
   * 
   * **Usage**:
   * - Remote calls: `this.ctn<RemoteDO>().method(args)`
   * - Local handlers: `this.ctn().handleResult(remoteResult)`
   * - Nesting: Use remote continuation as handler parameter
   * 
   * @example
   * ```typescript
   * // Remote continuation
   * const remote = this.ctn<UserDO>().getUserData(userId);
   * 
   * // Handler continuation with nested marker
   * const handler = this.ctn().processData(remote);
   * 
   * // Make call
   * await this.lmz.call('USER_DO', userId, remote, handler);
   * ```
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  ctn() {
    return newContinuation();
  }
  /**
   * Lifecycle hook called before each incoming mesh call is executed
   *
   * Override this method to:
   * - Validate authentication/authorization based on `this.lmz.callContext`
   * - Populate `callContext.state` with computed data
   * - Add logging or tracing metadata
   * - Reject unauthorized calls by throwing an error
   *
   * This hook is called BEFORE the operation chain is executed.
   * The `callContext` is available via `this.lmz.callContext`.
   *
   * **Important**: If you override this, remember to call `super.onBeforeCall()`
   * to ensure any parent class logic is also executed.
   *
   * @example
   * ```typescript
   * class AuthWorker extends LumenizeWorker<Env> {
   *   onBeforeCall(): void {
   *     super.onBeforeCall();
   *
   *     const { originAuth, callChain } = this.lmz.callContext;
   *
   *     // Only allow internal mesh calls (no client origin)
   *     if (callChain[0].type === 'LumenizeClient') {
   *       throw new Error('Direct client access not allowed');
   *     }
   *   }
   * }
   * ```
   */
  onBeforeCall() {
  }
  /**
   * Execute an OCAN (Operation Chaining And Nesting) operation chain on this Worker.
   *
   * This method enables remote DOs/Workers to call methods on this Worker via RPC.
   * Any Worker extending LumenizeWorker can receive remote calls without additional setup.
   *
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param chain - The operation chain to execute
   * @returns The result of executing the operation chain
   *
   * @example
   * ```typescript
   * // Remote DO/Worker sends this chain:
   * const remote = this.ctn<MyWorker>().processData(data);
   *
   * // This Worker receives and executes it:
   * const result = await this.__executeChain(remote);
   * // Equivalent to: this.processData(data)
   * ```
   */
  async __executeChain(chain) {
    return await executeOperationChain(chain, this);
  }
  /**
   * Get the local chain executor for internal use
   *
   * This method provides access to __executeChain with configurable options
   * for trusted internal code (like lmz.call() result handlers).
   *
   * **Security**: The returned function can bypass @mesh checks, but it won't
   * serialize over RPC boundaries so attackers can't use it remotely.
   *
   * @internal
   */
  get __localChainExecutor() {
    return (chain, options) => executeOperationChain(chain, this, options);
  }
  /**
   * Receive and execute an RPC call envelope with auto-initialization
   * 
   * Handles versioned envelopes and automatically initializes this Worker's identity
   * from the callee metadata included in the envelope. This enables Workers to learn
   * their binding name from the first incoming call.
   * 
   * **Envelope format**:
   * - `version: 1` - Current envelope version (required)
   * - `chain` - Preprocessed operation chain to execute
   * - `metadata.callee` - Identity of this Worker (used for auto-initialization)
   * 
   * @internal This is called by this.lmz.callRaw(), not meant for direct use
   * @param envelope - The call envelope with version, chain, and metadata
   * @returns The result of executing the operation chain
   * @throws Error if envelope version is not 1
   * 
   * @see [Usage Examples](https://lumenize.com/docs/lumenize-base/call) - Complete tested examples
   */
  async __executeOperation(envelope) {
    if (!envelope.version || envelope.version !== 1) {
      throw new Error(
        `Unsupported RPC envelope version: ${envelope.version}. This version of LumenizeWorker only supports v1 envelopes. Old-style calls without envelopes are no longer supported.`
      );
    }
    if (!envelope.callContext) {
      throw new Error(
        "Missing callContext in envelope. All mesh calls must include callContext."
      );
    }
    if (envelope.metadata?.callee) {
      this.lmz.__init({
        bindingName: envelope.metadata.callee.bindingName
        // instanceName ignored for Workers (always undefined)
      });
    }
    const operationChain = postprocess(envelope.chain);
    try {
      const result = await runWithCallContext(envelope.callContext, async () => {
        this.onBeforeCall();
        return await this.__executeChain(operationChain);
      });
      return { $result: result };
    } catch (error) {
      return { $error: preprocess(error) };
    }
  }
};

// ../../packages/mesh/src/nadis-plugin.ts
var NadisPlugin = class {
  /** The Durable Object instance that owns this plugin */
  doInstance;
  /** DurableObjectState for storage access */
  ctx;
  /** Access to other NADIS services */
  svc;
  /**
   * Initialize plugin with DO instance
   * @param doInstance - The LumenizeBase DO instance
   */
  constructor(doInstance) {
    this.doInstance = doInstance;
    this.ctx = doInstance.ctx;
    this.svc = doInstance.svc;
  }
  /**
   * Register a NADIS plugin in the global service registry
   * 
   * @param name - Service name (accessed as `this.svc[name]`)
   * @param factory - Factory function that receives doInstance and returns service
   */
  static register(name, factory) {
    if (!globalThis.__lumenizeServiceRegistry) {
      globalThis.__lumenizeServiceRegistry = {};
    }
    globalThis.__lumenizeServiceRegistry[name] = factory;
  }
};

// ../../packages/mesh/src/tab-id.ts
var PROBE_TIMEOUT_MS = 50;
var TAB_ID_KEY = "lmz_tab";
async function getOrCreateTabId(deps) {
  const stored = deps.sessionStorage.getItem(TAB_ID_KEY);
  if (stored) {
    const isInUse = await checkTabIdInUse(stored, deps);
    if (!isInUse) {
      setupTabIdListener(stored, deps);
      return stored;
    }
  }
  const tabId = crypto.randomUUID().slice(0, 8);
  deps.sessionStorage.setItem(TAB_ID_KEY, tabId);
  setupTabIdListener(tabId, deps);
  return tabId;
}
function setupTabIdListener(tabId, deps) {
  const channel = new deps.BroadcastChannel(tabId);
  channel.onmessage = () => {
    channel.postMessage("in-use");
  };
}
function checkTabIdInUse(tabId, deps) {
  return new Promise((resolve) => {
    const channel = new deps.BroadcastChannel(tabId);
    const timeout = setTimeout(() => {
      channel.close();
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    channel.onmessage = () => {
      clearTimeout(timeout);
      channel.close();
      resolve(true);
    };
    channel.postMessage("probe");
  });
}

// ../../packages/mesh/src/lumenize-client.ts
var MAX_QUEUE_SIZE = 100;
var MAX_RECONNECT_DELAY_MS = 3e4;
var INITIAL_RECONNECT_DELAY_MS = 1e3;
var CALL_RAW_QUEUE_TIMEOUT_MS = 3e4;
var DEFAULT_GATEWAY_BINDING = "LUMENIZE_CLIENT_GATEWAY";
var DEFAULT_REFRESH_ENDPOINT = "/auth/refresh-token";
var LoginRequiredError = class extends Error {
  constructor(message, code, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
  name = "LoginRequiredError";
};
globalThis.LoginRequiredError = LoginRequiredError;
var LumenizeClient = class {
  // ============================================
  // Private Fields
  // ============================================
  #config;
  #instanceName = null;
  #ws = null;
  #connectionState = "disconnected";
  #accessToken = null;
  #sub = null;
  #pendingCalls = /* @__PURE__ */ new Map();
  #messageQueue = [];
  #reconnectAttempts = 0;
  #reconnectTimeoutId;
  #currentCallContext = null;
  #WebSocketClass;
  #lmzApi = null;
  // ============================================
  // Constructor
  // ============================================
  constructor(config) {
    this.#config = {
      ...config,
      gatewayBindingName: config.gatewayBindingName ?? DEFAULT_GATEWAY_BINDING,
      refresh: config.refresh ?? DEFAULT_REFRESH_ENDPOINT
    };
    if (config.instanceName) {
      this.#instanceName = config.instanceName;
    }
    this.#WebSocketClass = config.WebSocket ?? globalThis.WebSocket;
    if (!this.#WebSocketClass) {
      throw new Error(
        "WebSocket is not available. In Node.js, provide WebSocket in config."
      );
    }
    if (config.accessToken) {
      this.#accessToken = config.accessToken;
    }
    this.#setupWakeUpSensing();
    this.connect();
  }
  // ============================================
  // Public Properties
  // ============================================
  /**
   * Current connection state
   */
  get connectionState() {
    return this.#connectionState;
  }
  /**
   * Lumenize API for mesh communication
   */
  get lmz() {
    if (!this.#lmzApi) {
      this.#lmzApi = this.#createLmzApi();
    }
    return this.#lmzApi;
  }
  #createLmzApi() {
    const self = this;
    const api = {
      type: "LumenizeClient",
      bindingName: self.#config.gatewayBindingName,
      get instanceName() {
        if (!self.#instanceName) {
          throw new Error(
            "instanceName is only available after connected state. When instanceName is auto-generated, it is constructed during the first connection."
          );
        }
        return self.#instanceName;
      },
      get callContext() {
        if (!self.#currentCallContext) {
          throw new Error(
            "Cannot access callContext outside of a mesh call. callContext is only available during @mesh handler execution."
          );
        }
        return self.#currentCallContext;
      },
      callRaw: self.#callRaw.bind(self),
      call: self.#call.bind(self)
    };
    return api;
  }
  ctn() {
    return newContinuation();
  }
  /**
   * Manually trigger reconnection
   *
   * Usually not needed — reconnection is automatic.
   */
  connect() {
    if (this.#connectionState === "connected" || this.#connectionState === "connecting") {
      return;
    }
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
      this.#reconnectTimeoutId = void 0;
    }
    this.#connectInternal();
  }
  /**
   * Close connection and clean up
   */
  disconnect() {
    if (this.#reconnectTimeoutId) {
      clearTimeout(this.#reconnectTimeoutId);
      this.#reconnectTimeoutId = void 0;
    }
    if (this.#ws) {
      this.#ws.onclose = null;
      this.#ws.onerror = null;
      this.#ws.onmessage = null;
      this.#ws.onopen = null;
      if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
        this.#ws.close(1e3, "Client disconnect");
      }
      this.#ws = null;
    }
    for (const [callId, pending] of this.#pendingCalls) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(new Error("Client disconnected"));
    }
    this.#pendingCalls.clear();
    for (const queued of this.#messageQueue) {
      if (queued.timeoutId) clearTimeout(queued.timeoutId);
      if (queued.reject) {
        queued.reject(new Error("Client disconnected"));
      }
    }
    this.#messageQueue = [];
    this.#setConnectionState("disconnected");
  }
  /**
   * Symbol.dispose for `using` keyword support
   */
  [Symbol.dispose]() {
    this.disconnect();
  }
  // ============================================
  // Lifecycle Hooks (Override in Subclass)
  // ============================================
  /**
   * Called before each incoming mesh call is executed
   *
   * Override to add authentication/authorization.
   * Default: reject calls from other LumenizeClients (peer-to-peer),
   * but allow calls that originated from this same client instance.
   *
   * Access context via `this.lmz.callContext`.
   */
  onBeforeCall() {
    const origin = this.#currentCallContext?.callChain[0];
    if (origin?.type === "LumenizeClient") {
      if (origin.instanceName === this.#instanceName) {
        return;
      }
      throw new Error(
        "Peer-to-peer client calls are disabled by default. Override onBeforeCall() to allow them."
      );
    }
  }
  // ============================================
  // Private - Connection Management
  // ============================================
  async #connectInternal() {
    const isReconnect = this.#connectionState === "reconnecting";
    this.#setConnectionState(isReconnect ? "reconnecting" : "connecting");
    try {
      if (!this.#instanceName && !this.#accessToken) {
        const tabIdDeps = this.#getTabIdDeps();
        const [tabId] = await Promise.all([
          tabIdDeps ? getOrCreateTabId(tabIdDeps) : Promise.resolve(crypto.randomUUID().slice(0, 8)),
          this.#refreshToken()
          // Sets this.#accessToken and this.#sub
        ]);
        this.#instanceName = `${this.#sub}.${tabId}`;
      } else if (!this.#accessToken) {
        await this.#refreshToken();
      }
      const url = this.#buildWebSocketUrl();
      const protocols = ["lmz"];
      if (this.#accessToken) {
        protocols.push(`lmz.access-token.${this.#accessToken}`);
      }
      this.#ws = new this.#WebSocketClass(url, protocols);
      const thisWs = this.#ws;
      this.#ws.onopen = () => this.#handleOpen();
      this.#ws.onclose = (event) => {
        if (this.#ws !== thisWs) return;
        this.#handleClose(event.code, event.reason);
      };
      this.#ws.onerror = (event) => this.#handleError(event);
      this.#ws.onmessage = (event) => this.#handleMessage(event.data);
    } catch (error) {
      this.#scheduleReconnect();
    }
  }
  #buildWebSocketUrl() {
    let baseUrl = this.#config.baseUrl;
    if (!baseUrl && typeof window !== "undefined") {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      baseUrl = `${protocol}//${window.location.host}`;
    }
    if (!baseUrl) {
      throw new Error("LumenizeClient requires baseUrl in Node.js environments");
    }
    if (baseUrl.startsWith("https://")) {
      baseUrl = baseUrl.replace("https://", "wss://");
    } else if (baseUrl.startsWith("http://")) {
      baseUrl = baseUrl.replace("http://", "ws://");
    }
    const binding = this.#config.gatewayBindingName;
    const instance = this.#instanceName;
    if (!instance) {
      throw new Error("instanceName not available \u2014 connect has not completed");
    }
    return `${baseUrl}/gateway/${binding}/${instance}`;
  }
  #handleOpen() {
    this.#reconnectAttempts = 0;
  }
  #handleClose(code, reason) {
    this.#ws = null;
    if (code === 4400 || code === 4403) {
      const error = new LoginRequiredError(
        `Authentication failed: ${reason}`,
        code,
        reason
      );
      this.#setConnectionState("disconnected");
      this.#config.onLoginRequired?.(error);
      return;
    }
    if (code === 4401) {
      this.#accessToken = null;
      this.#handleTokenExpired();
      return;
    }
    this.#scheduleReconnect();
  }
  async #handleTokenExpired() {
    try {
      await this.#refreshToken();
      this.#setConnectionState("reconnecting");
      this.#connectInternal();
    } catch (error) {
      const loginError = new LoginRequiredError(
        "Token refresh failed",
        401,
        "Refresh token expired or invalid"
      );
      this.#setConnectionState("disconnected");
      this.#config.onLoginRequired?.(loginError);
    }
  }
  #handleError(event) {
    const error = new Error("WebSocket error");
    this.#config.onConnectionError?.(error);
  }
  #scheduleReconnect() {
    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.#reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.#reconnectAttempts++;
    this.#setConnectionState("reconnecting");
    this.#reconnectTimeoutId = setTimeout(() => {
      this.#reconnectTimeoutId = void 0;
      this.#connectInternal();
    }, delay);
  }
  #setupWakeUpSensing() {
    if (typeof document === "undefined") return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.#connectionState === "reconnecting") {
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = void 0;
        }
        this.#connectInternal();
      }
    });
    window.addEventListener("focus", () => {
      if (this.#connectionState === "reconnecting") {
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = void 0;
        }
        this.#connectInternal();
      }
    });
    window.addEventListener("online", () => {
      if (this.#connectionState === "reconnecting" || this.#connectionState === "disconnected") {
        this.#reconnectAttempts = 0;
        if (this.#reconnectTimeoutId) {
          clearTimeout(this.#reconnectTimeoutId);
          this.#reconnectTimeoutId = void 0;
        }
        this.#connectInternal();
      }
    });
  }
  #setConnectionState(state) {
    if (this.#connectionState !== state) {
      this.#connectionState = state;
      this.#config.onConnectionStateChange?.(state);
    }
  }
  // ============================================
  // Private - Token Refresh
  // ============================================
  async #refreshToken() {
    const refresh = this.#config.refresh;
    if (typeof refresh === "function") {
      const result = await refresh();
      this.#accessToken = result.access_token;
      if (result.sub) {
        this.#sub = result.sub;
      }
    } else if (typeof refresh === "string") {
      const fetchFn = this.#config.fetch ?? fetch;
      const response = await fetchFn(refresh, {
        method: "POST",
        credentials: "include"
        // Include cookies
      });
      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status}`);
      }
      const data = await response.json();
      this.#accessToken = data.access_token ?? null;
      if (data.sub) {
        this.#sub = data.sub;
      }
    } else {
      throw new Error("No refresh method configured");
    }
    if (!this.#accessToken) {
      throw new Error("Refresh returned no token");
    }
  }
  /**
   * Get TabIdDeps from config or globals. Returns null if unavailable
   * (non-browser environment without injected deps).
   */
  #getTabIdDeps() {
    const sessionStorage = this.#config.sessionStorage ?? globalThis.sessionStorage;
    const BroadcastChannelCtor = this.#config.BroadcastChannel ?? globalThis.BroadcastChannel;
    if (!sessionStorage || !BroadcastChannelCtor) {
      return null;
    }
    return { sessionStorage, BroadcastChannel: BroadcastChannelCtor };
  }
  // ============================================
  // Private - Message Handling
  // ============================================
  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch (error) {
      console.error("Failed to parse Gateway message:", error);
      return;
    }
    switch (message.type) {
      case GatewayMessageType.CONNECTION_STATUS:
        this.#handleConnectionStatus(message);
        break;
      case GatewayMessageType.CALL_RESPONSE:
        this.#handleCallResponse(message);
        break;
      case GatewayMessageType.INCOMING_CALL:
        this.#handleIncomingCall(message);
        break;
      default:
        console.warn("Unknown Gateway message type:", message.type);
    }
  }
  #handleConnectionStatus(message) {
    this.#setConnectionState("connected");
    this.#flushMessageQueue();
    if (message.subscriptionRequired) {
      this.#config.onSubscriptionRequired?.();
    }
  }
  #handleCallResponse(message) {
    const pending = this.#pendingCalls.get(message.callId);
    if (!pending) {
      console.warn("Received response for unknown call:", message.callId);
      return;
    }
    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.#pendingCalls.delete(message.callId);
    if (message.success) {
      pending.resolve(postprocess(message.result));
    } else {
      const error = postprocess(message.error);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async #handleIncomingCall(message) {
    const { callId, chain: preprocessedChain, callContext: preprocessedCallContext } = message;
    try {
      const chain = postprocess(preprocessedChain);
      const callContext = {
        callChain: preprocessedCallContext.callChain,
        // Plain strings - no postprocessing
        originAuth: preprocessedCallContext.originAuth,
        // From JWT - no postprocessing
        state: postprocess(preprocessedCallContext.state)
        // Preprocessed → native
      };
      this.#currentCallContext = callContext;
      const result = await runWithCallContext(callContext, async () => {
        await this.onBeforeCall();
        return await executeOperationChain(chain, this);
      });
      const response = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: true,
        result: preprocess(result)
      };
      this.#send(JSON.stringify(response));
    } catch (error) {
      const response = {
        type: GatewayMessageType.INCOMING_CALL_RESPONSE,
        callId,
        success: false,
        error: preprocess(error)
      };
      this.#send(JSON.stringify(response));
    } finally {
      this.#currentCallContext = null;
    }
  }
  // ============================================
  // Private - Sending Messages
  // ============================================
  #send(message) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(message);
    }
  }
  #sendOrQueue(message, callId, resolve, reject) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(message);
    } else {
      if (this.#messageQueue.length >= MAX_QUEUE_SIZE) {
        const error = new Error("Message queue full");
        if (reject) {
          reject(error);
        }
        return;
      }
      const queued = { message, callId, resolve, reject };
      if (resolve && reject) {
        queued.timeoutId = setTimeout(() => {
          const index = this.#messageQueue.indexOf(queued);
          if (index >= 0) {
            this.#messageQueue.splice(index, 1);
            reject(new Error("Call timed out while waiting for connection"));
          }
        }, CALL_RAW_QUEUE_TIMEOUT_MS);
      }
      this.#messageQueue.push(queued);
    }
  }
  #flushMessageQueue() {
    const queue = this.#messageQueue;
    this.#messageQueue = [];
    for (const queued of queue) {
      if (queued.timeoutId) {
        clearTimeout(queued.timeoutId);
      }
      this.#send(queued.message);
    }
  }
  // ============================================
  // Private - RPC Methods
  // ============================================
  async #callRaw(calleeBindingName, calleeInstanceNameOrId, chainOrContinuation, options) {
    const chain = getOperationChain(chainOrContinuation) ?? chainOrContinuation;
    const callId = crypto.randomUUID();
    const callerIdentity = {
      type: "LumenizeClient",
      bindingName: this.#config.gatewayBindingName,
      instanceName: this.#instanceName
    };
    const callContext = buildOutgoingCallContext(callerIdentity, options);
    const message = {
      type: GatewayMessageType.CALL,
      callId,
      binding: calleeBindingName,
      instance: calleeInstanceNameOrId,
      chain: preprocess(chain),
      callContext: {
        callChain: callContext.callChain,
        // Plain strings - no preprocessing
        state: preprocess(callContext.state)
        // User-defined - may contain extended types
      }
    };
    const messageStr = JSON.stringify(message);
    return new Promise((resolve, reject) => {
      this.#pendingCalls.set(callId, { resolve, reject });
      this.#sendOrQueue(messageStr, callId, resolve, reject);
    });
  }
  #call(calleeBindingName, calleeInstanceNameOrId, remoteContinuation, handlerContinuation, options) {
    const { remoteChain, handlerChain } = extractCallChains(remoteContinuation, handlerContinuation);
    const capturedContext = captureCallContext();
    const localExecutor = (chain, opts) => executeOperationChain(chain, this, opts);
    const executeHandler = createHandlerExecutor(localExecutor, capturedContext);
    const callPromise = capturedContext ? runWithCallContext(capturedContext, () => this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options)) : this.#callRaw(calleeBindingName, calleeInstanceNameOrId, remoteChain, options);
    setupFireAndForgetHandler(callPromise, handlerChain, executeHandler);
  }
};

// ../../packages/auth/src/lumenize-auth.ts
import { DurableObject as DurableObject3 } from "cloudflare:workers";

// ../../packages/auth/src/jwt.ts
function base64UrlEncode(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
async function importPrivateKey(pem) {
  const normalizedPem = pem.replace(/\\n/g, "\n");
  const pemContents = normalizedPem.replace(/-----BEGIN PRIVATE KEY-----/g, "").replace(/-----END PRIVATE KEY-----/g, "").replace(/\s/g, "");
  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return await crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
}
function generateUuid() {
  return crypto.randomUUID();
}
async function signJwt(payload, privateKey, keyId) {
  const header = {
    alg: "EdDSA",
    typ: "JWT",
    kid: keyId
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureBuffer = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const encodedSignature = base64UrlEncode(signatureBuffer);
  return `${signingInput}.${encodedSignature}`;
}
function createJwtPayload(options) {
  const now = Math.floor(Date.now() / 1e3);
  return {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    exp: now + options.expiresInSeconds,
    iat: now,
    jti: generateUuid(),
    emailVerified: options.emailVerified,
    adminApproved: options.adminApproved,
    ...options.isAdmin ? { isAdmin: true } : {},
    ...options.act ? { act: options.act } : {}
  };
}

// ../../packages/auth/src/auth-email-sender-base.ts
import { WorkerEntrypoint as WorkerEntrypoint2 } from "cloudflare:workers";

// ../../packages/mesh/src/create-test-refresh-function.ts
function createTestRefreshFunction(options = {}) {
  const {
    sub = crypto.randomUUID(),
    adminApproved = true,
    emailVerified = true,
    isAdmin = false,
    iss = "https://lumenize.local",
    aud = "https://lumenize.local",
    ttl = 3600,
    expired = false
  } = options;
  return async () => {
    if (expired) {
      throw new Error("Refresh token expired");
    }
    let privateKeyPem = options.privateKey;
    if (!privateKeyPem) {
      const mod = await import("cloudflare:test");
      const env = mod.env;
      privateKeyPem = env?.JWT_PRIVATE_KEY_BLUE;
      if (!privateKeyPem) {
        throw new Error(
          "createTestRefreshFunction: no privateKey provided and JWT_PRIVATE_KEY_BLUE not found in cloudflare:test env"
        );
      }
    }
    const privateKey = await importPrivateKey(privateKeyPem);
    const payload = createJwtPayload({
      issuer: iss,
      audience: aud,
      subject: sub,
      expiresInSeconds: ttl,
      emailVerified,
      adminApproved,
      isAdmin: isAdmin || void 0
    });
    const accessToken = await signJwt(payload, privateKey, "BLUE");
    return { access_token: accessToken, sub };
  };
}
export {
  ClientDisconnectedError,
  GatewayMessageType,
  LoginRequiredError,
  LumenizeDO as LumenizeBase,
  LumenizeClient,
  LumenizeClientGateway,
  LumenizeDO,
  LumenizeWorker,
  MESH_CALLABLE,
  MESH_GUARD,
  NadisPlugin,
  createTestRefreshFunction,
  executeOperationChain,
  getMeshGuard,
  getOperationChain,
  getOrCreateTabId,
  isMeshCallable,
  isNestedOperationMarker,
  mesh,
  meshFn,
  newContinuation,
  replaceNestedOperationMarkers,
  validateOperationChain
};
