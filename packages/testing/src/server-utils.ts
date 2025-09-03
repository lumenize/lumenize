import { it, expect } from 'vitest';

/**
 * Check if the test server is available at module load time.
 * Attempts to ping the server at http://localhost:8787/ping with a 1-second timeout.
 * 
 * @returns Promise<boolean> - true if server responds with "pong", false otherwise
 */
export async function checkServerAvailability(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:8787/ping", {
      signal: AbortSignal.timeout(1000)
    });
    const responseBody = await response.text();
    const available = responseBody === "pong";
    console.log(`Server available: ${available}`);
    return available;
  } catch (error) {
    console.log("Server ping failed during module load:", error);
    return false;
  }
}

/**
 * Create a maybeIt function that conditionally runs tests based on server availability.
 * This is useful for integration tests that require a live server to be running.
 * 
 * @param serverAvailable - Whether the server is available
 * @returns A maybeIt function that behaves like vitest's `it` but skips tests when server is unavailable
 * 
 * @example
 * ```typescript
 * const serverAvailable = await checkServerAvailability();
 * const maybeIt = createMaybeIt(serverAvailable);
 * 
 * maybeIt("should call the API", async () => {
 *   // This test runs only if server is available, otherwise it's skipped
 * });
 * 
 * maybeIt.skip("should do something", async () => {
 *   // This test is always skipped
 * });
 * 
 * maybeIt.only("should run exclusively", async () => {
 *   // This test runs exclusively if server is available, otherwise skipped
 * });
 * ```
 */
export function createMaybeIt(serverAvailable: boolean) {
  function maybeIt(name: string, fn: () => Promise<any>) {
    if (serverAvailable) {
      it(name, fn);
    } else {
      it.skip(name, fn);
    }
  }

  // Enhanced maybeIt with support for .skip and .only
  maybeIt.skip = (name: string, fn: () => Promise<any>) => {
    it.skip(name, fn);
  };

  maybeIt.only = (name: string, fn: () => Promise<any>) => {
    if (serverAvailable) {
      it.only(name, fn);
    } else {
      it.skip(name, fn);
    }
  };

  return maybeIt;
}
