/**
 * The pure halves of `profile-pictures.ts` — the sniff and the key grammar. Pure by construction,
 * so this is the tier for them; the upload/serve round trip through real R2 is
 * `harness/scenarios/signup-to-first-app.ts` limb 8.
 */
import { describe, it, expect } from 'vitest';
import { sniffImage, isPictureKey } from '../src/profile-pictures';

const png  = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif  = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('sniffImage', () => {
  it('recognises the four served containers by magic bytes', () => {
    expect(sniffImage(png)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffImage(jpeg)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffImage(gif)).toEqual({ mime: 'image/gif', ext: 'gif' });
    expect(sniffImage(webp)).toEqual({ mime: 'image/webp', ext: 'webp' });
  });
  it('refuses what it cannot identify — a header claiming image/png buys nothing', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode('%PDF-1.7'))).toBeUndefined();
    expect(sniffImage(new Uint8Array(0))).toBeUndefined();
    expect(sniffImage(png.slice(0, 7))).toBeUndefined(); // a truncated signature is not a signature
  });
});

describe('isPictureKey', () => {
  const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  it('admits exactly {uuid}.{ext} for the served containers', () => {
    for (const ext of ['png', 'jpg', 'gif', 'webp']) expect(isPictureKey(`${uuid}.${ext}`)).toBe(true);
  });
  it('rejects anything that could name a different object', () => {
    expect(isPictureKey(`${uuid}.svg`)).toBe(false);
    expect(isPictureKey(`../${uuid}.png`)).toBe(false);
    expect(isPictureKey(`other/${uuid}.png`)).toBe(false);
    expect(isPictureKey(`${uuid}.png?x=1`)).toBe(false);
    expect(isPictureKey(`${uuid.toUpperCase()}.png`)).toBe(false); // the key is minted lowercase
    expect(isPictureKey('')).toBe(false);
  });
});
