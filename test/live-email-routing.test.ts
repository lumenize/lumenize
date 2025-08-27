/**
 * This test file only checks the functioning of the test-harness.
 * 
 * The test-harness is deployed to Cloudflare as it's own Worker and DO.
 * live-auth.test.ts uses that deployed test-harness to receive emails that come from
 * the auth magic link flow, which are sent by AWS SES to test.email@lumenize.com.
 * That address is configured in Cloudflare Email Routing to forward to the
 * test-harness Worker and DO.
 * 
 * The test in live-auth.test.ts establishes a WebSocket connection to the test-harness DO
 * before triggering the magic link email send, and then waits for notification that the email
 * arrived over that WebSocket connection before confirming the entire flow worked.
 */
import { describe, expect, beforeEach } from 'vitest';
import { checkServerAvailability, createMaybeIt } from './test-utils';

// Check server availability synchronously at module load time
const serverAvailable = await checkServerAvailability();
describe('Live Email Routing', () => {
  const maybeIt = createMaybeIt(serverAvailable);

  beforeEach(async () => {
    
  });

  maybeIt("should exercise email handler in test-harness.ts", async () => {
    const response = await fetch("http://localhost:8787/test-email-routing", {
      signal: AbortSignal.timeout(2000),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        setSender: { name: 'Lumenize', addr: 'auth@lumenize.com' },
        setRecipient: 'test.email@lumenize.com',
        setSubject: 'Testing the test-harness locally',
        addMessage: {
          contentType: 'text/plain',
          data: `Congratulations, this worked!`,
        }
      }),
    });
    expect(response.status).toBe(200);
    const { email }: any = await response.json();
    expect(email).toBeDefined();
    expect(email.subject).toBe('Testing the test-harness locally');
    expect(email.from.name).toBe('Lumenize');
    expect(email.from.address).toBe('auth@lumenize.com');
    expect(email.to[0].address).toBe('test.email@lumenize.com');
  });

});
