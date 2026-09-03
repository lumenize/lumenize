/**
 * Profile pictures — the platform's first blob: uploaded behind a bearer, served in public.
 *
 * `picture` is a PUBLIC profile field (ADR-012): anyone holding the profileId may read it, and it
 * is rendered by `<img>` tags on every surface — Studio, a built app under `/app/*`, and later the
 * `lumenize.dev` data plane, which is a different origin. An image load carries no bearer and, cross-
 * site, no cookie, so serving MUST be unauthenticated. Holding the URL is the capability, exactly as
 * holding the profileId is for the field itself (`calibration.md` § 1 — do not gate a public thing).
 *
 * The bucket is the platform's ONE blob bucket (`BLOBS`), never per-app infrastructure
 * (nebula-pre-alpha-fast-follow § blob storage). Keys are random and opaque (ADR-010) under a
 * `profile-pictures/` prefix; a new picture is a NEW key, so every URL is immutable and cached
 * forever, and a changed picture propagates by the Profile's own fanout, not by cache expiry.
 *
 * Trust boundary (security.md): the upload derives WHOSE picture from the VERIFIED claims — never
 * from the body or a header — sniffs the container from magic bytes rather than trusting
 * `Content-Type`, and bounds the size before reading it. The serve trusts nothing but the key's
 * shape, which admits no separator, so a key can never name anything outside the prefix.
 */
import { debug } from '@lumenize/debug';
import { verifyNebulaAccessToken } from '@lumenize/nebula-auth';

export const PICTURES_PREFIX = '/pictures';
/** A display avatar, not an archive — the SPA downscales before upload, so this is a hard ceiling
 *  against a raw camera file, not a target. */
export const PICTURE_MAX_BYTES = 2 * 1024 * 1024;
const KEY_PREFIX = 'profile-pictures/';
/** `{uuid}.{ext}` and nothing else — no `/`, no `..`, no query. */
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

export interface ImageKind { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; ext: 'png' | 'jpg' | 'gif' | 'webp' }

/** The container, from magic bytes. `undefined` for anything that is not one of the four we serve. */
export function sniffImage(b: Uint8Array): ImageKind | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return { mime: 'image/gif', ext: 'gif' };
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: 'image/webp', ext: 'webp' };
  return undefined;
}

/** The public URL segment (`{uuid}.{ext}`) is exactly what may follow `/pictures/`. */
export function isPictureKey(segment: string): boolean {
  return KEY_RE.test(segment);
}

function refuse(status: number, error: string, description: string): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/** `PUT /pictures` — body is the image bytes; answers `{ url }` for the Profile to store. */
export async function handlePictureUpload(request: Request, env: Env): Promise<Response> {
  const log = debug('nebula.pictures.upload');
  const auth = request.headers.get('Authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const jwt = token ? await verifyNebulaAccessToken(token, env) : null;
  if (!jwt) return refuse(401, 'invalid_token', 'A valid access token is required');
  if (!jwt.profileId) return refuse(403, 'no_profile', 'This session carries no profile to attach a picture to');

  // Bound BEFORE reading: a declared size over the cap is refused without buffering it.
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > PICTURE_MAX_BYTES) return refuse(413, 'too_large', `Pictures are capped at ${PICTURE_MAX_BYTES} bytes`);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) return refuse(400, 'empty', 'No image bytes were sent');
  if (bytes.byteLength > PICTURE_MAX_BYTES) return refuse(413, 'too_large', `Pictures are capped at ${PICTURE_MAX_BYTES} bytes`);
  const kind = sniffImage(bytes);
  if (!kind) return refuse(415, 'unsupported_type', 'PNG, JPEG, GIF or WebP only');

  const segment = `${crypto.randomUUID()}.${kind.ext}`;
  await env.BLOBS.put(KEY_PREFIX + segment, bytes, {
    httpMetadata: { contentType: kind.mime, cacheControl: IMMUTABLE },
    // Attribution only — never an authorization input (the serve is public by design).
    customMetadata: { profileId: jwt.profileId },
  });
  // Absolute, from the origin the request arrived on — the same rule emailed links follow, so the
  // URL is right wherever the Worker is being driven from (local vite, test-nebula, prod).
  const url = `${new URL(request.url).origin}${PICTURES_PREFIX}/${segment}`;
  log.info('stored', { profileId: jwt.profileId, bytes: bytes.byteLength, type: kind.mime });
  return Response.json({ url, bytes: bytes.byteLength, type: kind.mime });
}

/** `GET /pictures/{key}` — public, immutable. */
export async function servePicture(segment: string, env: Env): Promise<Response> {
  if (!isPictureKey(segment)) return new Response('Not Found', { status: 404 });
  const obj = await env.BLOBS.get(KEY_PREFIX + segment);
  if (!obj) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', IMMUTABLE);
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(obj.body, { headers });
}
