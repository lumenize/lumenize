/**
 * **A GET or HEAD that carries a body gets the same answer as one that does not.**
 *
 * A browser never sends one, but anything on the internet may. On 2026-10-15 a scanner's
 * `GET /auth/login` with `content-length: 0` reached the platform host's auth forward in the
 * Worker's `fetch`, which rebuilt every request whose `body` was not null, and `new Request`
 * threw `Request with a GET or HEAD method cannot have a body`: a 500, and a new Workers Issue on
 * the test target. Sent with raw `node:http`, since `fetch` refuses to send such a request.
 *
 * Each method's answer must equal its answer to the plain request, which is whatever the stack
 * serves at `/auth/login`, for two bodies: an empty one, the scanner's, which reds only deployed
 * (a local stack answered it 200 before the fix), and five bytes, which reds in both venues.
 * *Reds when the forward rebuilds a GET's or a HEAD's body again.*
 *
 * `needsContainer = false`.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { DevStack } from '../lib/harness';

export const needsContainer = false;

/** The status a raw request answers, carrying `body` when one is given. */
function statusOf(url: string, method: string, body?: string): Promise<number> {
  const target = new URL(url);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) };
    const req = send(target, { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

export async function run(stack: DevStack): Promise<void> {
  const url = `${stack.baseUrl}/auth/login`;
  const answers: string[] = [];
  for (const method of ['GET', 'HEAD']) {
    const plain = await statusOf(url, method);
    for (const body of ['', 'hello']) {
      const bodied = await statusOf(url, method, body);
      answers.push(`${method} with ${body.length} bytes: ${bodied}, plain ${plain}`);
      assert.equal(bodied, plain, `a ${method} carrying ${body.length} bytes answered ${bodied} where the plain one answered ${plain}`);
    }
  }
  console.log(`✅ a bodied GET and HEAD answer as the plain ones — ${answers.join('; ')}`);
}
