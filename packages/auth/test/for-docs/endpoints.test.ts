/**
 * Documentation validation tests for Auth endpoint examples
 *
 * Each it() block contains doc code verbatim so the @check-example plugin
 * finds it as a substring after normalization (imports stripped, comments
 * stripped, whitespace collapsed).
 *
 * The `fetch` wrapper bridges the gap between doc examples (bare `fetch`
 * with relative URLs) and vitest Workers (which need `browser.fetch` with
 * absolute URLs). The normalizer strips imports but preserves `const`
 * declarations, so `const fetch = ...` is invisible to the substring
 * matcher — only the downstream `await fetch('/auth/...')` calls matter.
 */
import { describe, it, expect } from 'vitest';
import { testLoginWithMagicLink, parseJwtUnsafe } from '@lumenize/auth';
import { Browser } from '@lumenize/testing';

describe('Auth Endpoint Examples', () => {

  // ─── Authentication Endpoints ─────────────────────────────────────

  describe('Authentication Endpoints', () => {

    // Matches index.mdx:164 — Request Magic Link (no Turnstile)
    it('request magic link', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const response = await fetch('/auth/email-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'user@example.com' })
      });

      expect(response.status).toBe(200);
    }, { timeout: 5000 });

    // Matches index.mdx:322 and api-reference.mdx:114 — Magic Link with Turnstile
    it('request magic link with turnstile', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);
      const turnstileToken = 'test-token';

      const response = await fetch('/auth/email-magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'user@example.com',
          'cf-turnstile-response': turnstileToken  // from the Turnstile widget callback
        })
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject(
        {
          message: "Check your email for the magic link",
          expires_in: 1800
        }
      );
    }, { timeout: 5000 });

    // Matches index.mdx:371 — Test Mode Magic Link
    // Also matches api-reference.mdx response shape for test mode
    it('request magic link test mode', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const response = await fetch('/auth/email-magic-link?_test=true', {
        method: 'POST',
        body: JSON.stringify({ email: 'test@example.com' })
      });

      const body = await response.json();
      expect(body.magic_link).toBeDefined();
      expect(body).toMatchObject(
        {
          message: "Magic link generated (test mode)"
        }
      );
    }, { timeout: 5000 });

    // Matches api-reference.mdx:157 — Refresh Token
    it('refresh token', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      // Login first to get refresh token cookie
      await testLoginWithMagicLink(browser, 'refresh-test@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch('/auth/refresh-token', { method: 'POST' });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.access_token).toBeDefined();
    }, { timeout: 5000 });

    // Matches index.mdx:198 and api-reference.mdx:170 — Logout
    it('logout', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      // Login first to get refresh token cookie
      await testLoginWithMagicLink(browser, 'logout-test@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch('/auth/logout', { method: 'POST' });
      const body = await response.json();
      expect(body).toMatchObject(
        {
          message: "Logged out"
        }
      );
    }, { timeout: 5000 });
  });

  // ─── Subject Management Endpoints ─────────────────────────────────

  describe('Subject Management Endpoints', () => {

    // Matches api-reference.mdx:183 — List Subjects
    it('list subjects', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'list-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      const response = await fetch('/auth/subjects', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const { subjects } = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(subjects)).toBe(true);
    }, { timeout: 5000 });

    // Matches api-reference.mdx:199 — List Subjects with Filters
    it('list subjects with filters', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'filter-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      const response = await fetch('/auth/subjects?role=admin&limit=50', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      expect(response.status).toBe(200);
    }, { timeout: 5000 });

    // Matches api-reference.mdx:210 — Get Subject
    it('get subject', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'get-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      // Create a subject to get
      const targetBrowser = new Browser();
      const { sub } = await testLoginWithMagicLink(targetBrowser, 'get-target@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch(`/auth/subject/${sub}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.sub).toBe(sub);
    }, { timeout: 5000 });

    // Matches api-reference.mdx:224 — Update Subject
    it('update subject', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'update-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      // Create a subject to update
      const targetBrowser = new Browser();
      const { sub } = await testLoginWithMagicLink(targetBrowser, 'update-target@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch(`/auth/subject/${sub}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          isAdmin: true
        })
      });
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.isAdmin).toBe(true);
    }, { timeout: 5000 });

    // Matches api-reference.mdx:264 — Invite Subjects
    it('invite subjects', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'invite-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      const response = await fetch('/auth/invite', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          emails: ['alice@example.com', 'bob@example.com']
        })
      });
      const { invited, errors } = await response.json();

      expect(response.status).toBe(200);
      expect(invited).toContain('alice@example.com');
      expect(invited).toContain('bob@example.com');
    }, { timeout: 5000 });

    // Matches api-reference.mdx:246 — Delete Subject
    it('delete subject', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'delete-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      // Create a throwaway subject to delete
      const targetBrowser = new Browser();
      const { sub } = await testLoginWithMagicLink(targetBrowser, 'delete-target@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch(`/auth/subject/${sub}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      expect(response.status).toBe(204);
    }, { timeout: 5000 });
  });

  // ─── Delegation Endpoints ─────────────────────────────────────────

  describe('Delegation Endpoints', () => {

    // Matches api-reference.mdx:323 — Add Authorized Actor
    it('add authorized actor', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken: adminAccessToken } = await testLoginWithMagicLink(browser, 'actor-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      // Create the target subject and the actor subject
      const targetBrowser = new Browser();
      const { sub: targetSub } = await testLoginWithMagicLink(targetBrowser, 'actor-target@example.com', {
        subjectData: { adminApproved: true }
      });
      const actorBrowser = new Browser();
      const { sub: actorSubId } = await testLoginWithMagicLink(actorBrowser, 'actor-actor@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch(`/auth/subject/${targetSub}/actors`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ actorSub: actorSubId })
      });
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.authorizedActors).toContain(actorSubId);
    }, { timeout: 10000 });

    // Matches api-reference.mdx:342 — Remove Authorized Actor
    it('remove authorized actor', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken: adminAccessToken } = await testLoginWithMagicLink(browser, 'remove-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      // Create actor and target, add actor first
      const targetBrowser = new Browser();
      const { sub: targetSub } = await testLoginWithMagicLink(targetBrowser, 'remove-target@example.com', {
        subjectData: { adminApproved: true }
      });
      const actorBrowser = new Browser();
      const { sub: actorSubId } = await testLoginWithMagicLink(actorBrowser, 'remove-actor@example.com', {
        subjectData: { adminApproved: true }
      });

      // Add actor first
      await fetch(`/auth/subject/${targetSub}/actors`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ actorSub: actorSubId })
      });

      const response = await fetch(`/auth/subject/${targetSub}/actors/${actorSubId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${adminAccessToken}` }
      });
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.authorizedActors).not.toContain(actorSubId);
    }, { timeout: 10000 });

    // Matches api-reference.mdx:357 — Request Delegated Token
    it('request delegated token', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      // Setup: admin authorizes actor for target
      const { accessToken: adminToken } = await testLoginWithMagicLink(browser, 'deleg-admin@example.com', {
        subjectData: { isAdmin: true }
      });
      const targetBrowser = new Browser();
      const { sub: targetSub } = await testLoginWithMagicLink(targetBrowser, 'deleg-target@example.com', {
        subjectData: { adminApproved: true }
      });
      const actorBrowser = new Browser();
      const { accessToken: actorAccessToken, sub: actorSub } = await testLoginWithMagicLink(actorBrowser, 'deleg-actor@example.com', {
        subjectData: { adminApproved: true }
      });

      // Authorize actor
      await fetch(`/auth/subject/${targetSub}/actors`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ actorSub: actorSub })
      });

      const response = await fetch('/auth/delegated-token', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${actorAccessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          actFor: targetSub  // Subject ID to act on behalf of
        })
      });
      const { access_token } = await response.json();

      expect(response.status).toBe(200);
      expect(access_token).toBeDefined();
      const claims = parseJwtUnsafe(access_token).payload;
      expect(claims.sub).toBe(targetSub);
      expect(claims.act.sub).toBe(actorSub);
    }, { timeout: 10000 });

    // Matches api-reference.mdx:382 — Using Delegated Tokens (guard code)
    it('using delegated tokens', async () => {
      const browser = new Browser();

      // Setup: get a delegated token
      const { accessToken: adminToken } = await testLoginWithMagicLink(browser, 'guard-admin@example.com', {
        subjectData: { isAdmin: true }
      });
      const targetBrowser = new Browser();
      const { sub: ownerId } = await testLoginWithMagicLink(targetBrowser, 'guard-target@example.com', {
        subjectData: { adminApproved: true }
      });
      const actorBrowser = new Browser();
      const { accessToken: actorToken, sub: actorSub } = await testLoginWithMagicLink(actorBrowser, 'guard-actor@example.com', {
        subjectData: { adminApproved: true }
      });

      // Authorize and get delegated token
      await browser.fetch(`https://localhost/auth/subject/${ownerId}/actors`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ actorSub: actorSub })
      });
      const delegResponse = await actorBrowser.fetch('https://localhost/auth/delegated-token', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${actorToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ actFor: ownerId })
      });
      const delegBody = await delegResponse.json() as any;
      const claims = parseJwtUnsafe(delegBody.access_token).payload as any;

      // Guard checks sub (principal's permissions)
      if (claims.sub !== ownerId) throw new Error('Forbidden');

      // Audit logging includes actor if present
      const actor = claims.act ? `${claims.act.sub} for ` : '';
      console.log(`Document updated by ${actor}${claims.sub}`);

      expect(claims.sub).toBe(ownerId);
      expect(claims.act.sub).toBe(actorSub);
    }, { timeout: 10000 });
  });
});
