import { describe, expect, beforeEach } from 'vitest';
import { checkServerAvailability, createMaybeIt } from './test-utils';

// Check server availability synchronously at module load time
const serverAvailable = await checkServerAvailability();
describe('Live auth', () => {
  const maybeIt = createMaybeIt(serverAvailable);

  beforeEach(async () => {
    
  });

  maybeIt("send discovery email and receive session cookie", async () => {
    const response = await fetch("http://localhost:8787/api/auth/magic-link-requested", {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'larry@maccherone.com',
        mode: 'development', // or 'production'
      }),
    });
    expect(response.status).toBe(200);
    const data = await response.json() as {
      success: boolean;
      message: string;
    };
    expect(data.success).toBe(true);
    expect(data.message).toBe('Magic link email sent');
  });

  maybeIt("should fail when sending to malformed email address", async () => {
    const response = await fetch("http://localhost:8787/api/auth/magic-link-requested", {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: 'someone',  // Malformed email
        mode: 'development',
      }),
    });
    expect(response.status).toBe(500);
    const data = await response.json() as {
      error: string;
      details: string;
    };
    expect(data.error).toBe('Failed to send magic link email');
    expect(data.details).toContain("Missing final '@domain'");
  });

});
