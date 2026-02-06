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

    // Matches auth-flow.mdx — Request Magic Link (no Turnstile)
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

    // Matches auth-flow.mdx and getting-started.mdx — Magic Link with Turnstile
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
      // @ts-ignore — response.json() returns unknown
      const body = await response.json();
      expect(body).toMatchObject(
        {
          message: "Check your email for the magic link",
          expires_in: 1800
        }
      );
    }, { timeout: 5000 });

    // Matches auth-flow.mdx and testing.mdx — Test Mode Magic Link
    it('request magic link test mode', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const response = await fetch('/auth/email-magic-link?_test=true', {
        method: 'POST',
        body: JSON.stringify({ email: 'test@example.com' })
      });

      // @ts-ignore — response.json() returns unknown
      const body = await response.json();
      // @ts-ignore — body is unknown from response.json()
      expect(body.magic_link).toBeDefined();
      expect(body).toMatchObject(
        {
          message: "Magic link generated (test mode)"
        }
      );
    }, { timeout: 5000 });

    // Matches auth-flow.mdx — Refresh Token
    it('refresh token', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      // Login first to get refresh token cookie
      await testLoginWithMagicLink(browser, 'refresh-test@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch('/auth/refresh-token', { method: 'POST' });

      expect(response.status).toBe(200);
      // @ts-ignore — response.json() returns unknown
      const body = await response.json();
      // @ts-ignore — body is unknown from response.json()
      expect(body.access_token).toBeDefined();
    }, { timeout: 5000 });

    // Matches auth-flow.mdx — Logout
    it('logout', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      // Login first to get refresh token cookie
      await testLoginWithMagicLink(browser, 'logout-test@example.com', {
        subjectData: { adminApproved: true }
      });

      const response = await fetch('/auth/logout', { method: 'POST' });
      // @ts-ignore — response.json() returns unknown
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

    // Matches subject-management.mdx — List Subjects
    it('list subjects', async () => {
      const browser = new Browser();
      const fetch = (url: string, init?: RequestInit) => browser.fetch(`https://localhost${url}`, init);

      const { accessToken } = await testLoginWithMagicLink(browser, 'list-admin@example.com', {
        subjectData: { isAdmin: true }
      });

      const response = await fetch('/auth/subjects', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      // @ts-ignore — response.json() returns unknown
      const { subjects } = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(subjects)).toBe(true);
    }, { timeout: 5000 });

    // Matches subject-management.mdx — List Subjects with Filters
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

    // Matches subject-management.mdx — Get Subject
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
      // @ts-ignore — response.json() returns unknown
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.sub).toBe(sub);
    }, { timeout: 5000 });

    // Matches subject-management.mdx — Update Subject
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
      // @ts-ignore — response.json() returns unknown
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.isAdmin).toBe(true);
    }, { timeout: 5000 });

    // Matches subject-management.mdx — Invite Subjects
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
      // @ts-ignore — response.json() returns unknown
      const { invited, errors } = await response.json();

      expect(response.status).toBe(200);
      expect(invited).toContain('alice@example.com');
      expect(invited).toContain('bob@example.com');
    }, { timeout: 5000 });

    // Matches subject-management.mdx — Delete Subject
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

    // Matches delegation.mdx — Add Authorized Actor
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
      // @ts-ignore — response.json() returns unknown
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.authorizedActors).toContain(actorSubId);
    }, { timeout: 10000 });

    // Matches delegation.mdx — Remove Authorized Actor
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
      // @ts-ignore — response.json() returns unknown
      const { subject } = await response.json();

      expect(response.status).toBe(200);
      expect(subject.authorizedActors).not.toContain(actorSubId);
    }, { timeout: 10000 });

    // Matches delegation.mdx — Request Delegated Token
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
      // @ts-ignore — response.json() returns unknown
      const { access_token } = await response.json();

      expect(response.status).toBe(200);
      expect(access_token).toBeDefined();
      // @ts-ignore — parseJwtUnsafe returns nullable
      const claims = parseJwtUnsafe(access_token)!.payload;
      expect(claims.sub).toBe(targetSub);
      // @ts-ignore — claims.act may be undefined
      expect(claims.act.sub).toBe(actorSub);
    }, { timeout: 10000 });

    // Matches delegation.mdx — Using Delegated Tokens (guard code)
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
      // @ts-ignore — response.json() returns unknown
      const delegBody = await delegResponse.json();
      // @ts-ignore — parseJwtUnsafe returns nullable
      const claims = parseJwtUnsafe(delegBody.access_token)!.payload;

      // Guard checks sub (principal's permissions)
      if (claims.sub !== ownerId) throw new Error('Forbidden');

      // Audit logging includes actor if present
      const actor = claims.act ? `${claims.act.sub} for ` : '';
      console.log(`Document updated by ${actor}${claims.sub}`);

      expect(claims.sub).toBe(ownerId);
      // @ts-ignore — claims.act may be undefined
      expect(claims.act.sub).toBe(actorSub);
    }, { timeout: 10000 });
  });
});
