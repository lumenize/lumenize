# @lumenize/utils

Utility functions for Cloudflare Workers and Durable Objects.

## getDONamespaceFromPathname

The `getDONamespaceFromPathname` function provides intelligent case conversion to resolve Durable Object namespaces from URL pathnames. It takes a URL pathname and automatically finds the matching Durable Object namespace in your environment, handling various naming conventions seamlessly.

## getDOStubFromPathname

The `getDOStubFromPathname` function combines namespace resolution with stub creation. It extracts both the binding name (first path segment) and instance name (second path segment) from the URL pathname, then returns a ready-to-use Durable Object stub.

### Usage

```typescript
import { getDONamespaceFromPathname } from '@lumenize/utils';

// In your Cloudflare Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      const durableObjectNamespace = getDONamespaceFromPathname(url.pathname, env);
      const stub = durableObjectNamespace.getByName("instance-name");
      return stub.fetch(request);
    } catch (error: any) {
      const status = error.httpErrorCode || 500;
      return new Response(error.message, { status });
    }
  }
};
```

### Supported Case Conversions

The function intelligently converts URL path segments to match various binding naming conventions:

| URL Path Segment | Matches Binding Names |
|------------------|----------------------|
| `/my-do/...` | `MY_DO`, `MyDO`, `MyDo`, `myDo`, `my-do` |
| `/user-session/...` | `USER_SESSION`, `UserSession`, `userSession`, `user-session` |
| `/my-d-o/...` | `MY_D_O`, `MyDO`, `MyDO`, `myDO`, `my-d-o` |
| `/api-handler/...` | `API_HANDLER`, `ApiHandler`, `apiHandler`, `api-handler` |

### Error Handling

If multiple bindings match the same path segment, `getDONamespaceFromPathname` will throw a `MultipleBindingsFoundError` to prevent ambiguity. Each error includes an `httpErrorCode` property for easy HTTP response handling:

- **`InvalidPathError`** (400): Empty or invalid path format
- **`DOBindingNotFoundError`** (404): No matching binding found
- **`MultipleBindingsFoundError`** (400): Multiple bindings match the path segment

### Parameters

- **`pathname`** (string): The URL pathname (e.g., `/my-do/some/path`)
- **`env`** (Record<string, any>): The Cloudflare Workers environment object containing Durable Object bindings

### Returns

The function returns the matched Durable Object namespace (DurableObjectNamespace) that can be used to create stubs.

### Examples

```typescript
// Environment has: { MY_DO: durableObjectNamespace }
const namespace = getDONamespaceFromPathname('/my-do/websocket', env);

// Environment has: { UserSession: durableObjectNamespace }  
const namespace = getDONamespaceFromPathname('/user-session/connect', env);

// Environment has: { API_HANDLER: durableObjectNamespace }
const namespace = getDONamespaceFromPathname('/api-handler/process', env);
```

The function uses runtime duck typing to identify Durable Object namespaces by checking for the presence of `getByName` and `idFromName` methods, filtering out other environment variables like KV namespaces, R2 buckets, or simple strings/numbers.

---

## getDOStubFromPathname

The `getDOStubFromPathname` function is a convenience wrapper that combines `getDONamespaceFromPathname` with stub creation. It extracts both the binding name and instance name from the URL pathname and returns a ready-to-use Durable Object stub.

### Usage

```typescript
import { getDOStubFromPathname } from '@lumenize/utils';

// In your Cloudflare Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    try {
      const stub = getDOStubFromPathname(url.pathname, env);
      return stub.fetch(request);
    } catch (error: any) {
      const status = error.httpErrorCode || 500;
      return new Response(error.message, { status });
    }
  }
};
```

### URL Format

The function expects URLs in the format: `/binding-name/instance-name/...`

- **First segment**: Binding name (case conversion applied)
- **Second segment**: Instance name (used as-is, case-sensitive)
- **Remaining segments**: Passed through to the Durable Object

### Instance Name Handling

Instance names are used exactly as provided in the URL path - **no case conversion is applied**. This preserves case-sensitive identifiers like GUIDs, user IDs, or other unique identifiers.

### Examples

```typescript
// URL: /my-do/user-session-abc123/connect
// Binding: MY_DO, Instance: "user-session-abc123"
const stub = getDOStubFromPathname('/my-do/user-session-abc123/connect', env);

// URL: /user-session/550e8400-e29b-41d4-a716-446655440000/data
// Binding: UserSession, Instance: "550e8400-e29b-41d4-a716-446655440000"
const stub = getDOStubFromPathname('/user-session/550e8400-e29b-41d4-a716-446655440000/data', env);

// URL: /api-handler/CaseSensitive-ID-123/process
// Binding: API_HANDLER, Instance: "CaseSensitive-ID-123"
const stub = getDOStubFromPathname('/api-handler/CaseSensitive-ID-123/process', env);
```

### Parameters

- **`pathname`** (string): The URL pathname (e.g., `/my-do/instance-123/some/path`)
- **`env`** (Record<string, any>): The Cloudflare Workers environment object containing Durable Object bindings

### Returns

The function returns a DurableObjectStub that can be used to send requests to the specific Durable Object instance.

### Error Handling

In addition to the errors from `getDONamespaceFromPathname`, this function adds:

- **`InvalidStubPathError`** (400): Missing instance name in URL path

All errors include an `httpErrorCode` property for easy HTTP response handling.
