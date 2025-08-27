import { routePartykitRequest } from 'partyserver';
export { Lumenize } from './lumenize-server';
import { magicLinkRequestedHandler } from './magic-link-requested-handler';
import { magicLinkClickedHandler } from './magic-link-clicked-handler';

export default {

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.debug('%o', {
      type: 'debug',
      where: 'Worker fetch routing',
      request: {
        method: request.method,
        url: request.url,
      },
    });

    try {  // Routing. Each route handler should return undefined if it doesn't handle the request
      const magicLinkRequestedResponse = await magicLinkRequestedHandler(request, env, ctx );
      if (magicLinkRequestedResponse) {
        return magicLinkRequestedResponse;
      }

      const magicLinkClickedResponse = await magicLinkClickedHandler(request, env, ctx );
      if (magicLinkClickedResponse) {
        return magicLinkClickedResponse;
      }

      // TODO: Consider forking routePartykitRequest to allow for universes first and custom domains later
      const response = await routePartykitRequest(request, { ...env }, {  // TODO: Move this to a separate file like lumenize-handler.ts
        prefix: 'universe',  // TODO: Drive this from universe name in D1 or Workers KV
        onBeforeConnect: (request) => {
          // Auth code goes here
          //
          // Think of this as middleware for the WebSocket upgrade request.
          // 
          // If it returns a Request, it will be used instead of the original request. Use this to modify 
          // headers or other request properties before passing it to the Durable Object.
          // 
          // If it returns a Response, the original request will never make it to it the Durable Object.
          // The returned Response will be sent back to the caller instead. This is ideal for returning a 403 
          // on a failed authentication check in the Worker layer before putting load on the Durable Object.
          //
          // If it returns undefined or null, the request will be passed to the server as normal.
          console.debug('%o', {
            type: 'debug', 
            where: 'lumenize-worker.ts routing onBeforeConnect', 
            request
          });
          
          // TODO: Confirm that we really neeed this cross-origin check
          const isTestEnv = env.ENVIRONMENT === 'test' || env.ENVIRONMENT === 'development';
          if (!isTestEnv) {
            // Only check origin in production/staging
            const origin = request.headers.get('origin');  
            if (!origin?.endsWith('transformation.dev')) {  // TODO: Will need to drive this with an environment variable if we allow people to run their own servers or we host at a different domain like my-company.lumenize.com or hosted.lumenize.com
              return Response.json({ message: 'Forbidden - Invalid origin' }, { status: 403 });
            }
          } else {
            console.warn('%o', {
              type: 'warn',
              where: 'lumenize-worker.ts routing onBeforeConnect',
              message: 'Skipping origin check in test or development environment'
            });
          }
          
          // TODO: Check the Session ID here. If it fails...
          // return Response.json({"error": "Not authorized"}, { status: 403 })

          return undefined; // Continue passing the request on to the Durable Object
        },
      }); 

      if (response) {
        return response
      } 
    } catch (e) {
      console.error('%o', {
        type: 'error',
        where: 'lumenize-worker.ts routing',
        stack: e instanceof Error ? e.stack : undefined,
        message: e instanceof Error ? e.message : 'Unknown error',
        request,  // TODO: Can't return full request because it may have sensitive data in headers
      });
      return Response.json({ message: 'Internal server error' }, { status: 500 });
    };

    return Response.json({ message: 'Not found' }, { status: 404 });
  }

} satisfies ExportedHandler<Env>;
