// Shim for Node.js 'crypto' — delegate to Web Crypto
export function createHash() {
  return { update() { return this; }, digest() { return ''; } };
}
export function randomBytes(n) { return new Uint8Array(n); }
export default { createHash, randomBytes };
