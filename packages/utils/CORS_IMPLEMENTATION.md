# CORS Implementation for routeDORequest

## Overview

Added comprehensive CORS (Cross-Origin Resource Sharing) support to `routeDORequest`, matching the functionality of Cloudflare's `@cloudflare/agents` package implementation while maintaining simplicity and platform-agnostic compatibility.

## Features

### 1. Flexible Configuration

The `cors` option supports three modes:

- **`false`** (default): No CORS headers are added
- **`true`** (permissive): Reflects any request's Origin header
- **`{ origin: string[] | (origin: string) => boolean }`**: Custom validation

### 2. CORS Behavior

When CORS is enabled and origin is allowed:
- Sets `Access-Control-Allow-Origin: <origin>` (reflects the request's origin)
- Sets `Vary: Origin` header
- Does NOT set `Access-Control-Allow-Credentials` (not supported in this implementation)

### 3. Preflight (OPTIONS) Request Handling

- Automatically handles OPTIONS requests when origin is allowed
- Returns `204 No Content` with CORS headers
- Does not forward to Durable Object (short-circuits the request)
- If no Origin header present OR origin not allowed, passes through to DO

### 4. Integration with Hooks

CORS headers are added to responses from:
- The Durable Object itself
- `onBeforeConnect` hook responses
- `onBeforeRequest` hook responses

Only adds headers when origin is allowed - respects validation logic.

### 5. Platform-Agnostic

- Uses standard Web Platform Request/Response APIs
- No external dependencies
- Compatible with Cloudflare Workers, Durable Objects, and other edge runtimes

## API

### Type Definition

```typescript
export type CorsOptions = 
  | false  // No CORS headers
  | true   // Permissive: echo any Origin
  | {
      origin: string[] | ((origin: string, request: Request) => boolean);
    };
```

### Usage Examples

#### Permissive Mode (Allow All Origins)

```typescript
await routeDORequest(request, env, {
  cors: true
});
```

#### Whitelist Specific Origins

```typescript
await routeDORequest(request, env, {
  cors: {
    origin: ['https://app.example.com', 'https://admin.example.com']
  }
});
```

#### Custom Validation Function

```typescript
await routeDORequest(request, env, {
  cors: {
    origin: (origin, request) => {
      // Check origin domain
      if (!origin.endsWith('.example.com')) {
        return false;
      }
      
      // Also inspect the request for additional validation
      const apiKey = request.headers.get('X-API-Key');
      if (!apiKey || apiKey !== 'trusted-key') {
        return false;
      }
      
      // Block certain HTTP methods
      if (request.method === 'DELETE') {
        return false;
      }
      
      // Check user agent to block bots
      const userAgent = request.headers.get('User-Agent');
      if (userAgent?.toLowerCase().includes('bot')) {
        return false;
      }
      
      return true;
    }
  }
});
```

The validator function receives both the `origin` string and the full `Request` object, allowing you to implement sophisticated CORS policies based on multiple request attributes.

#### Combined with Hooks and Prefix

```typescript
await routeDORequest(request, env, {
  prefix: '/api',
  cors: { origin: ['https://app.example.com'] },
  onBeforeRequest: async (request, context) => {
    // Auth logic here
    const token = request.headers.get('Authorization');
    if (!token) {
      return new Response('Unauthorized', { status: 401 });
      // CORS headers will be added to this response if origin is allowed
    }
  }
});
```

## Implementation Details

### Key Functions

1. **`isOriginAllowed(origin: string, corsOptions: CorsOptions, request: Request): boolean`**
   - Checks if an origin is allowed based on configuration
   - Handles all three CORS modes (false, true, object)
   - Passes the full request to validator functions for advanced checks

2. **`addCorsHeaders(response: Response, origin: string): Response`**
   - Creates new Response with CORS headers added
   - Preserves original response body, status, and all other headers
   - Adds `Access-Control-Allow-Origin` and `Vary` headers

### Request Flow

1. Parse and match DO route
2. Check if Origin header is present and CORS is enabled
3. Validate origin against configuration
4. If OPTIONS request and origin allowed → return 204 with CORS headers
5. Execute hooks (if any)
6. Forward to Durable Object
7. Add CORS headers to response if origin was allowed

## Testing

Comprehensive test suite with 64 tests covering:

- ✅ Default behavior (no CORS)
- ✅ Permissive mode
- ✅ Whitelist validation
- ✅ Function validator (with request parameter)
- ✅ Function validator with request inspection (method, headers, etc.)
- ✅ Preflight (OPTIONS) requests
- ✅ Integration with hooks
- ✅ Integration with prefix routing
- ✅ WebSocket requests
- ✅ Header preservation
- ✅ Edge cases (ports, null origin, case-sensitivity)

All tests passing: **64/64** ✓

## Security Considerations

1. **No credentials support**: This implementation does not set `Access-Control-Allow-Credentials`, meaning cookies and authorization headers won't be sent cross-origin even if the origin is allowed.

2. **Origin validation**: Always validates the Origin header when CORS is enabled - never allows requests without proper origin validation in whitelist/function modes.

3. **Vary header**: Always sets `Vary: Origin` to ensure proper caching behavior with CDNs and browsers.

## Migration from Manual CORS Implementation

If you're currently implementing CORS manually in your Worker:

**Before:**
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowedOrigins = ['https://app.example.com'];
    
    if (request.method === 'OPTIONS' && origin && allowedOrigins.includes(origin)) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Vary': 'Origin'
        }
      });
    }
    
    const response = await routeDORequest(request, env);
    if (!response) {
      return new Response('Not Found', { status: 404 });
    }
    
    if (origin && allowedOrigins.includes(origin)) {
      const headers = new Headers(response.headers);
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Vary', 'Origin');
      return new Response(response.body, {
        status: response.status,
        headers
      });
    }
    
    return response;
  }
};
```

**After:**
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routeDORequest(request, env, {
      cors: { origin: ['https://app.example.com'] }
    });
    
    return response ?? new Response('Not Found', { status: 404 });
  }
};
```

## Advanced Use Cases

### Multi-Factor CORS Validation

The function validator's access to the full `Request` object enables sophisticated CORS policies:

```typescript
await routeDORequest(request, env, {
  cors: {
    origin: (origin, request) => {
      // 1. Check origin whitelist
      const trustedOrigins = ['https://app.example.com', 'https://admin.example.com'];
      const trustedDomains = ['.example.com', '.example.dev'];
      
      const isOriginTrusted = 
        trustedOrigins.includes(origin) ||
        trustedDomains.some(domain => origin.endsWith(domain));
      
      if (!isOriginTrusted) return false;
      
      // 2. Additional request-based checks
      
      // Check authentication token for sensitive operations
      if (request.method !== 'GET') {
        const authToken = request.headers.get('Authorization');
        if (!authToken?.startsWith('Bearer ')) return false;
      }
      
      // Block known bad user agents
      const userAgent = request.headers.get('User-Agent') || '';
      const blockedAgents = ['badbot', 'scraper'];
      if (blockedAgents.some(agent => userAgent.toLowerCase().includes(agent))) {
        return false;
      }
      
      // Rate limiting hint - check for rate limit headers
      const rateLimitRemaining = request.headers.get('X-RateLimit-Remaining');
      if (rateLimitRemaining && parseInt(rateLimitRemaining) === 0) {
        return false;
      }
      
      return true;
    }
  }
});
```

### Environment-Specific CORS

```typescript
// Different CORS policies per environment
const getCorsConfig = (env: Env): CorsOptions => {
  if (env.ENVIRONMENT === 'production') {
    return {
      origin: (origin, request) => {
        // Strict validation in production
        const allowedOrigins = ['https://app.example.com'];
        if (!allowedOrigins.includes(origin)) return false;
        
        // Require API key in production
        const apiKey = request.headers.get('X-API-Key');
        return apiKey === env.PRODUCTION_API_KEY;
      }
    };
  }
  
  if (env.ENVIRONMENT === 'staging') {
    return {
      // Whitelist for staging
      origin: ['https://staging.example.com', 'https://preview.example.com']
    };
  }
  
  // Development - allow all
  return true;
};

await routeDORequest(request, env, {
  cors: getCorsConfig(env)
});
```

### Method-Specific CORS

```typescript
await routeDORequest(request, env, {
  cors: {
    origin: (origin, request) => {
      // Allow GET/HEAD from any subdomain
      if (request.method === 'GET' || request.method === 'HEAD') {
        return origin.endsWith('.example.com');
      }
      
      // Only allow POST/PUT/DELETE from specific origins
      const writeOrigins = ['https://app.example.com', 'https://admin.example.com'];
      return writeOrigins.includes(origin);
    }
  }
});
```

## Compatibility

- ✅ Cloudflare Workers
- ✅ Cloudflare Durable Objects
- ✅ Any runtime supporting Web Platform Request/Response APIs
- ✅ Works with WebSocket upgrade requests
- ✅ Compatible with all existing `routeDORequest` features (prefix, hooks, etc.)

## Future Enhancements

Potential improvements (not currently implemented):

- `Access-Control-Allow-Methods` header configuration
- `Access-Control-Allow-Headers` header configuration
- `Access-Control-Max-Age` header configuration
- `Access-Control-Expose-Headers` configuration
- `Access-Control-Allow-Credentials` support (would require significant changes)

These are intentionally excluded to keep the implementation simple and focused on the most common use case: allowing cross-origin requests from specific origins without credentials.
