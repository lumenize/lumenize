/**
 * Base64 for the `arraybuffer` tag's bytes.
 *
 * Uses the runtime's `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64`
 * where it has them, and otherwise `btoa` and `atob` over chunks: spreading a
 * large array into one `String.fromCharCode` call overflows the stack.
 */

// Arguments per `String.fromCharCode` call, well under every engine's limit.
const CHUNK = 0x8000;

// Padded standard base64, the only form the encoder writes. Checked before
// decoding so every runtime refuses the same strings, whichever decoder it has.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as any).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * @throws DOMException named `DataCloneError` when `base64` is not a string
 *   of padded standard base64.
 */
export function base64ToBytes(base64: unknown): Uint8Array {
  if (typeof base64 !== 'string') {
    throw new DOMException('Could not deserialize arraybuffer: base64 is not a string', 'DataCloneError');
  }
  if (!BASE64.test(base64)) {
    throw new DOMException('Could not deserialize arraybuffer: base64 is not base64', 'DataCloneError');
  }
  const native = (Uint8Array as any).fromBase64;
  if (typeof native === 'function') return native(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
