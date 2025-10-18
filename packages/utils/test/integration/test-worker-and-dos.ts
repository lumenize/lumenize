import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error For some reason this import is not always recognized
import { Env } from 'cloudflare:test';
import { routeDORequest, routeAgentRequest } from '../../src/index';

/**
 * Simple test Durable Object that returns info about the request
 */
export class TestDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    return Response.json({
      id: this.ctx.id.toString(),
      url: url.pathname + url.search, // Include query string
      method: request.method,
      headers,
    });
  }
}

/**
 * Another test DO with a different name for case conversion testing
 */
export class MyDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return Response.json({
      doType: 'MyDO',
      instanceId: this.ctx.id.toString(),
      lumenizeHeaders: {
        instanceNameOrId: request.headers.get('x-lumenize-do-instance-name-or-id'),
        bindingName: request.headers.get('x-lumenize-do-binding-name'),
      },
      agentHeaders: {
        room: request.headers.get('x-partykit-room'),
        namespace: request.headers.get('x-partykit-namespace'),
      },
    });
  }
}

/**
 * Test DO with multi-word kebab-case name
 */
export class UserSession extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    return Response.json({
      doType: 'UserSession',
      bindingName: request.headers.get('x-lumenize-do-binding-name'),
    });
  }
}

/**
 * Test worker that uses routeDORequest
 * 
 * Documentation example - basic usage:
 */
const _basicUsageExample = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Try routing to a Durable Object
    const response = await routeDORequest(request, env);
    if (response) return response;
    
    // Fallback for non-DO routes
    return new Response('Not Found', { status: 404 });
  }
};

/**
 * Documentation example - idiomatic pattern with multiple routers:
 */
const _idiomaticExample = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      await routeDORequest(request, env, { prefix: '/do' }) ||
      await routeAgentRequest(request, env) || // default prefix is '/agents'
      new Response("Not Found", { status: 404 })
    );
  }
};

/**
 * Documentation example - error handling with httpErrorCode:
 */
const _errorHandlingExample = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return (
        await routeDORequest(request, env, { prefix: '/do' }) ||
        await routeAgentRequest(request, env) || // default prefix is '/agents'
        new Response("Not Found", { status: 404 })
      );
    } catch (error: any) {
      // Handle MissingInstanceNameError, MultipleBindingsFoundError, etc.
      const status = error.httpErrorCode || 500;
      return new Response(error.message, { status });
    }
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      
      // Route based on URL prefix to avoid calling multiple routing functions
      // with the same request (important for requests with bodies)
      if (url.pathname.startsWith('/do/')) {
        const response = await routeDORequest(request, env, { prefix: '/do' });
        if (response) return response;
      } else if (url.pathname.startsWith('/agents/')) {
        const response = await routeAgentRequest(request, env, { prefix: '/agents' });
        if (response) return response;
      } else {
        // Try routing without prefix
        const response = await routeDORequest(request, env);
        if (response) return response;
      }
      
      // Fallback
      return new Response('Not Found', { status: 404 });
    } catch (error: any) {
      // Return error info for testing
      return Response.json({
        error: error.message,
        name: error.name,
        code: error.code,
        httpErrorCode: error.httpErrorCode,
      }, { 
        status: error.httpErrorCode || 500 
      });
    }
  },
};
