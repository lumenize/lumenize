/**
 * How far AHEAD of a token's `exp` a Client refreshes it, in seconds.
 *
 * ⚠️ **A coupling, not an implementation detail.** A token whose whole lifetime is at or under this
 * window is *born* already due for refresh, so it re-mints continuously — which makes this value
 * the floor under any caller-chosen token TTL. The auth layer's `RECOMMENDED_MIN_TTL_SECONDS` is
 * defined as a multiple of it, so changing the number here moves that one too.
 *
 * A leaf module of its own, so the auth layer reads it without importing the Client: `lmz-api.ts`
 * reads the scope grammar, so a Client → auth → Client cycle would leave this binding
 * uninitialized when a bundle evaluates the auth types first.
 */
export const TOKEN_REFRESH_AHEAD_SECONDS = 30;
