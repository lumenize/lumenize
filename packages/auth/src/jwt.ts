import type { JwtHeader, JwtPayload } from './types';

/**
 * Base64URL encode a string or ArrayBuffer
 */
function base64UrlEncode(data: string | ArrayBuffer): string {
  const bytes = typeof data === 'string' 
    ? new TextEncoder().encode(data)
    : new Uint8Array(data);
  
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64URL decode to ArrayBuffer
 */
function base64UrlDecode(str: string): ArrayBuffer {
  // Add padding if needed
  let padded = str;
  const pad = str.length % 4;
  if (pad) {
    padded += '='.repeat(4 - pad);
  }
  
  // Replace URL-safe chars
  const base64 = padded
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Import an Ed25519 private key from PEM format
 * Handles both actual newlines and escaped \n from environment variables
 */
export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Handle escaped newlines from env vars
  const normalizedPem = pem.replace(/\\n/g, '\n');
  
  // Remove PEM headers and decode
  const pemContents = normalizedPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');
  
  // Standard base64 decode (not base64url)
  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return await crypto.subtle.importKey(
    'pkcs8',
    bytes.buffer,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
}

/**
 * Import an Ed25519 public key from PEM format
 * Handles both actual newlines and escaped \n from environment variables
 */
export async function importPublicKey(pem: string): Promise<CryptoKey> {
  // Handle escaped newlines from env vars
  const normalizedPem = pem.replace(/\\n/g, '\n');
  
  // Remove PEM headers and decode
  const pemContents = normalizedPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
  
  // Standard base64 decode (not base64url)
  const binaryString = atob(pemContents);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return await crypto.subtle.importKey(
    'spki',
    bytes.buffer,
    { name: 'Ed25519' },
    false,
    ['verify']
  );
}

/**
 * Generate a cryptographically random string
 */
export function generateRandomString(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes.buffer);
}

/**
 * Generate a UUID v4
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Hash a string using SHA-256
 */
export async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hashBuffer);
}

/**
 * Sign a JWT using Ed25519
 * 
 * @param payload - JWT payload claims
 * @param privateKey - Ed25519 private key
 * @param keyId - Key identifier (BLUE or GREEN)
 * @returns Signed JWT string
 */
export async function signJwt(
  payload: JwtPayload,
  privateKey: CryptoKey,
  keyId: string
): Promise<string> {
  const header: JwtHeader = {
    alg: 'EdDSA',
    typ: 'JWT',
    kid: keyId
  };
  
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'Ed25519' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  
  const encodedSignature = base64UrlEncode(signatureBuffer);
  
  return `${signingInput}.${encodedSignature}`;
}

/**
 * Verify a JWT signature using Ed25519
 * 
 * @param token - JWT string
 * @param publicKey - Ed25519 public key
 * @returns Decoded payload if valid, null if invalid
 */
export async function verifyJwt(
  token: string,
  publicKey: CryptoKey
): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  
  try {
    const signatureBuffer = base64UrlDecode(encodedSignature);
    
    const isValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signatureBuffer,
      new TextEncoder().encode(signingInput)
    );
    
    if (!isValid) {
      return null;
    }
    
    const payloadJson = new TextDecoder().decode(base64UrlDecode(encodedPayload));
    const payload = JSON.parse(payloadJson) as JwtPayload;
    
    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload;
  } catch {
    return null;
  }
}

/**
 * Verify JWT with multiple public keys (for key rotation)
 * Tries each key until one succeeds
 * 
 * @param token - JWT string
 * @param publicKeys - Array of public keys to try
 * @returns Decoded payload if valid, null if invalid
 */
export async function verifyJwtWithRotation(
  token: string,
  publicKeys: CryptoKey[]
): Promise<JwtPayload | null> {
  for (const publicKey of publicKeys) {
    const payload = await verifyJwt(token, publicKey);
    if (payload) {
      return payload;
    }
  }
  return null;
}

/**
 * Parse a JWT without verification (for debugging/inspection)
 * WARNING: Do not trust the payload without verification!
 */
export function parseJwtUnsafe(token: string): { header: JwtHeader; payload: JwtPayload } | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  
  try {
    const headerJson = new TextDecoder().decode(base64UrlDecode(parts[0]));
    const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
    
    return {
      header: JSON.parse(headerJson) as JwtHeader,
      payload: JSON.parse(payloadJson) as JwtPayload
    };
  } catch {
    return null;
  }
}

/**
 * Create a JWT payload with standard claims and auth flags
 */
export function createJwtPayload(options: {
  issuer: string;
  audience: string;
  subject: string;
  expiresInSeconds: number;
  emailVerified: boolean;
  adminApproved: boolean;
  isAdmin?: boolean;
  act?: { sub: string; act?: any };
}): JwtPayload {
  const now = Math.floor(Date.now() / 1000);

  return {
    iss: options.issuer,
    aud: options.audience,
    sub: options.subject,
    exp: now + options.expiresInSeconds,
    iat: now,
    jti: generateUuid(),
    emailVerified: options.emailVerified,
    adminApproved: options.adminApproved,
    ...(options.isAdmin ? { isAdmin: true } : {}),
    ...(options.act ? { act: options.act } : {}),
  };
}

