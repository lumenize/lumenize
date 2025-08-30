import { SESClient, VerifyEmailIdentityCommand } from "@aws-sdk/client-ses";

export async function verifySenderEmail(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const splitPath = url.pathname.split('/');

  console.debug('%o', {
    type: 'debug',
    where: 'verifySenderEmail Handler',
    request,  // TODO: Remove request (or at least headers) from debug logs in production
    splitPath,
    env,  // TODO: Remove env from debug logs in production
    ctx,
  });

  // Handle discovery requests
  if (splitPath[1] !== 'verify-sender-email' || request.method !== 'POST') {
    return undefined;
  }
  
  const sesClient = new SESClient({
    region: 'us-east-2',
    credentials: {  // Not sure these are needed. They may automatically pull from environment variables
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  const input = { // VerifyEmailIdentityRequest
    EmailAddress: "email@lumenize.com", // TODO: Replace with the email address in body of request
  };
  const command = new VerifyEmailIdentityCommand(input);
  const response = await sesClient.send(command);
console.log('%o', { response });

  sesClient.destroy();

  return Response.json({
    success: true,
    message: 'Verify sender email sent',
  });

}