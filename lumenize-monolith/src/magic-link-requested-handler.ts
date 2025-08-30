import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

function generateSessionToken() {
  return crypto.randomUUID();
}

export async function magicLinkRequestedHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | undefined> {
  const route = '/api/auth/magic-link-requested'
  const url = new URL(request.url);

  if (!url.pathname.startsWith(route) || request.method !== 'POST') {
    return undefined;
  }

  let body: any;
  try {
    body = await request.json();
  } catch (err) {
    return Response.json(
      { error: "Error parsing expected JSON body", details: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }

  console.debug('%o', {
    type: 'debug',
    where: 'magicLinkRequestedHandler',
    request: {
      method: request.method,
      url: request.url,
      body,
    },
    route,
    ctx,
  });

  // Validate email in body
  const email = body?.email;
  if (!email || typeof email !== 'string') {
    return Response.json({ error: 'Missing or invalid email in request body' }, { status: 400 });
  }

  // Generate magicLinkToken and store email in SESSIONS KV
  const magicLinkToken = generateSessionToken();
  const sessionValue = JSON.stringify({ email });
  const expiration = 10 * 60; // 10 minutes
  await env.SESSIONS.put(magicLinkToken, sessionValue, { expirationTtl: expiration });

  // Compose the magic link redirect URL (add magicLinkToken as search param)
  let baseUrl: string;
  if (body?.mode === 'development') {
    baseUrl = 'http://localhost:8787';
  } else {
    baseUrl = url.origin || 'https://lumenize.com';
  }
  const magicLinkUrl = new URL(`${baseUrl}/api/auth/magic-link-clicked`);
  magicLinkUrl.searchParams.set('magicLinkToken', magicLinkToken);

  // Use default Lumenize branding since we don't know the galaxy yet
  const logoUrl = 'https://lumenize.com/images/lumenize-logo.png';
  const welcomeMsg = 'Welcome to Lumenize';

  // Compose the HTML body with the logo and welcome message
  const htmlBody = `
    <div style="text-align:center;">
      <img src="${logoUrl}" alt="Logo" width="128" height="128" style="margin-bottom:24px;" />
      <h2>${welcomeMsg}</h2>
      <p><a href="${magicLinkUrl.toString()}" style="font-size:1.2em; color:#C9A100; text-decoration:underline;">Click here to login or signup</a></p>
    </div>
  `;

  // Use SendEmailCommand (not SendRawEmailCommand)
  const paramsForEmail = {
    Source: 'Lumenize <auth@lumenize.com>',
    Destination: { ToAddresses: [email] },
    Message: {
      Subject: { Data: 'Lumenize Login/Signup Link', Charset: 'UTF-8' },
      Body: {
        Html: { Data: htmlBody, Charset: 'UTF-8' },
        Text: { Data: `${welcomeMsg}!\nLogin or signup: ${magicLinkUrl.toString()}`, Charset: 'UTF-8' },
      },
    },
    ReturnPath: 'auth@lumenize.com',
  };

  // Create AWS SES client and send email
  const sesClient = new SESClient({
    region: env.AWS_DEFAULT_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  try {
    const awsSESResponse = await sesClient.send(new SendEmailCommand(paramsForEmail));
    console.log({ awsSESResponse });
    sesClient.destroy();

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Magic link email sent',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (error) {
    sesClient.destroy();
    console.error('Failed to send email:', error);
    
    return Response.json(
      { 
        error: 'Failed to send magic link email', 
        details: error instanceof Error ? error.message : String(error) 
      },
      { status: 500 }
    );
  }
}
