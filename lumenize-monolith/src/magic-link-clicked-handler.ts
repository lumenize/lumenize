function generateSessionToken() {
  return crypto.randomUUID();
}

export async function magicLinkClickedHandler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | undefined> {
  const route = '/api/auth/magic-link-clicked'
  const url = new URL(request.url);

  if (!url.pathname.startsWith(route) || request.method !== 'GET') {
    return undefined;
  }

  // Extract magicLinkToken from search params
  const magicLinkToken = url.searchParams.get('magicLinkToken');
  if (!magicLinkToken) {
    return Response.json({ error: 'Missing magicLinkToken in magic link' }, { status: 400 });
  }

  // Retrieve session info from SESSIONS KV
  const sessionValue = await env.SESSIONS.get(magicLinkToken);
  if (!sessionValue) {
    return Response.json({ error: 'Invalid or expired magicLinkToken' }, { status: 401 });
  }
  let session: { email: string; galaxy: string };
  try {
    session = JSON.parse(sessionValue);
  } catch {
    return Response.json({ error: 'Corrupt session data' }, { status: 500 });
  }

  // At this point, user has proven control of the email address
  // Generate intermediateToken and set as cookie
  const intermediateToken = generateSessionToken();
  const intermediateValue = JSON.stringify({ email: session.email, galaxy: session.galaxy });
  const expiration = 10 * 60; // 10 minutes
  await env.SESSIONS.put(intermediateToken, intermediateValue, { expirationTtl: expiration });
  const cookieParts = [
    `intermediateToken=${intermediateToken}`,
    'HttpOnly',
    'SameSite=Strict',
    `Path=/`,
    `Max-Age=${expiration}`,
  ];
  if (url.protocol === 'https:') {
    cookieParts.push('Secure');
  }
  const cookie = cookieParts.join('; ');

  const redirectUrl = `${url.origin}/auth/magic-link-redirect`;
  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirectUrl,
      'Set-Cookie': cookie,
    },
  });
}

/*
TODOS:

- Create api/auth/stars-i-can-access
  - This should return a list of stars the user can access based on their email
  - This will be used to populate the star select dropdown

- Create api/auth/star-select
  - This will exchange the magicLinkToken for a starToken
  - More than one starToken can be stored client side

- Create api/auth/star-create
  - Make the appropriate changes to the D1 database
  - Add the user in the star DO as the star owner and star admin
  - This will also exchange the magicLinkToken for a starToken, like the star-select endpoint.
    So, we should just extract that common logic into a shared function that both handlers can call.

*/
