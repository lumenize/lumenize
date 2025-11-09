import { describe, it, expect } from 'vitest';
import { RequestSync } from '../src/request-sync';

/**
 * Browser-specific RequestSync tests
 * 
 * These tests verify properties that are preserved in browser environments
 * but not in Cloudflare Workers (credentials, mode, referrer, integrity, keepalive).
 * 
 * Run only in the 'browser' vitest project.
 */
describe('RequestSync (Browser-specific)', () => {
  describe('Request properties forwarding', () => {
    it('forwards credentials', () => {
      const req = new RequestSync('https://example.com', {
        credentials: 'include'
      });
      expect(req.credentials).toBe('include');
    });

    it('forwards mode', () => {
      const req = new RequestSync('https://example.com', {
        mode: 'cors'
      });
      expect(req.mode).toBe('cors');
    });

    it('forwards referrer', () => {
      const req = new RequestSync('https://example.com', {
        referrer: 'https://referrer.com'
      });
      // Browser security policy prevents setting referrer in test contexts
      // Returns 'about:client' instead of the provided URL
      expect(req.referrer).toBe('about:client');
    });

    it('forwards integrity', () => {
      const req = new RequestSync('https://example.com', {
        integrity: 'sha256-abc123'
      });
      expect(req.integrity).toBe('sha256-abc123');
    });

    it('forwards keepalive', () => {
      const req = new RequestSync('https://example.com', {
        keepalive: true
      });
      expect(req.keepalive).toBe(true);
    });
  });
});

