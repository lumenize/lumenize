import * as PostalMime from 'postal-mime';
import { Lumenize as LumenizeBase} from '../src';
import { Tool } from '../src/tool-registry';
import { createMimeMessage } from './simple-mime-message';
import lumenizeWorker from '../src/lumenize-worker';

// TODO: Export a DO that will be the target for Cloudflare Email Routing or put it in a separate project
export class Lumenize extends LumenizeBase {
  // Implement DO methods as needed for WebSocket forwarding of emails to test
  
  // Override onStart to add test-specific tools
  onStart() {    
    // Call parent onStart to initialize base tools
    super.onStart();
    
    // Add test-specific tools
    const subtractTool: Tool = {
      name: 'subtract',
      description: 'Subtract two numbers',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'The first number' },
          b: { type: 'number', description: 'The second number' },
        },
        required: ['a', 'b'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          result: { type: 'number', description: 'The result of subtracting b from a' },
        },
        required: ['result'],
      },
      handler: (args: Record<string, any> = {}) => {
        // No need to validate args because that will automatically be done using the inputSchema
        // No need to duplicate type definitions - trust the schema validation
        const { a, b } = args;
        return { result: a - b };
      }
    };

    const badSubtractTool: Tool = {
      ...subtractTool,
      name: 'bad-subtract',
      description: 'Subtract two numbers but returns result as a string (to test outputSchema validation)',
      outputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string'},
        },
        required: ['result'],
      },
    };
    
    // Use the protected tools property to add test tools
    this.tools.add(subtractTool);
    this.tools.add(badSubtractTool);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {    
    try {
      const url = new URL(request.url);
      const splitPath = url.pathname.split('/');

      // Handle test-specific routes first, before delegating to main worker
      if (splitPath[1] === 'ping') {
        return new Response('pong');
      }

      if (splitPath[1] === 'test-email-routing' && request.method === 'POST') {
        return await handleLiveEmailRoutingTest(request, env, ctx, this);
      }

      // Endpoint for testing auth magic link
      if (splitPath[1] === 'auth' && splitPath[2] === 'magic-link-redirect' && request.method === 'GET') {
        // This is a test endpoint to simulate the magic link redirect
        // In production, this would redirect to the app with the session cookie set
        const html = `
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <title>Magic Link Redirect</title>
          </head>
          <body>
            <h1>Magic link redirect successful</h1>
          </body>
          </html>
        `;
        return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
      }

      // For all other routes, delegate to the main worker logic
      // This handles magic-link auth, routePartykitRequest, and fallback routing
      return await lumenizeWorker.fetch(request, env, ctx);
    } catch (error) {
      console.error('TestHarness: Error in fetch handler:', error);
      return new Response(`Error: ${(error as Error).message}`, { status: 500 });
    }
  },

  // *** NOTE: THIS IS NOT ACTIVE. I COULDN'T FIGURE OUT HOW TO DEPLOY AN EMAIL WORKER. I EDITED IN THE CLOUDLFARE DASHBOARD ***
  async email(message: any, env: Env, ctx: ExecutionContext): Promise<any> {
    const forwardToTransformationDev = ["larry"];

    // Parse the recipient email address
    const emailParts = message.to.split('@');
    const username = emailParts[0];
    const domain = emailParts[1];

    // Check if this email should be forwarded to @transformation.dev
    if (domain === 'lumenize.com' && forwardToTransformationDev.includes(username)) {
      const forwardTo = `${username}@transformation.dev`;
      console.log(`Forwarding email from ${message.to} to ${forwardTo}`);
      await message.forward(forwardTo);
      return; // Email forwarded, no need to process further
    }

    // For all other emails, parse and potentially send to DO for WebSocket forwarding
    const parser = new PostalMime.default();
    const rawEmail = new Response(message.raw);
    const email = await parser.parse(await rawEmail.arrayBuffer());
    // TODO: If not forwarded above, send to the DO for forwarding over WebSocket to live-auth.test.ts
    return { email };  // return for local testing of this email handler, which is ignored in production
  },

} satisfies ExportedHandler<Env>;


async function handleLiveEmailRoutingTest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  objectWithEmailHandler: any
): Promise<any> {
  const body: any = await request.json();

  const msg = createMimeMessage().populateFromObject(body);

  const emailResponse = await objectWithEmailHandler.email({ raw: msg.asRaw() }, env, ctx);
  return Response.json(emailResponse);
}
