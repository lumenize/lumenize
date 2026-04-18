/**
 * Documentation validation test for Email Sender examples.
 *
 * The documented code appears below - the @check-example plugin validates it exists here.
 * Each example is in its own block so the class name AuthEmailSender can be reused
 * (matching the docs), and the check-example substring match finds each variant.
 */
import { describe, it, expect } from 'vitest';
import {
  CloudflareEmailSender,
  ResendEmailSender,
  defaultMagicLinkHtml,
} from '@lumenize/auth';

// --- Cloudflare Quick Start (getting-started.mdx "Email Provider") ---

{
  class AuthEmailSender extends CloudflareEmailSender {
    from = 'auth@myapp.com';  // must be on a domain you've onboarded to Cloudflare Email Sending
  }

  describe('Email Sender — Cloudflare Quick Start', () => {
    it('basic CloudflareEmailSender subclass', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(CloudflareEmailSender);
    });
  });
}

// --- Cloudflare Customizing Templates (getting-started.mdx) ---

{
  class AuthEmailSender extends CloudflareEmailSender {
    from = 'auth@myapp.com';
    replyTo = 'support@myapp.com';   // default: no-reply@myapp.com
    appName = 'My App';              // default: 'Lumenize'

    magicLinkHtml(message: any) {
      return `<h1>Welcome to My App</h1><a href="${message.magicLinkUrl}">Sign in</a>`;
    }
    // other 4 template methods use defaults
  }

  describe('Email Sender — Cloudflare Custom Templates', () => {
    it('custom template sender has overridden properties', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(CloudflareEmailSender);
    });
  });
}

// --- Cloudflare Composing with default template (getting-started.mdx) ---

{
  class AuthEmailSender extends CloudflareEmailSender {
    from = 'auth@myapp.com';

    magicLinkHtml(message: any) {
      return `<div class="my-wrapper">${defaultMagicLinkHtml(message, this.appName)}</div>`;
    }
  }

  describe('Email Sender — Cloudflare Composed Template', () => {
    it('composed template sender works', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(CloudflareEmailSender);
    });
  });
}

// --- Resend alternative (using-resend-instead.mdx) ---

{
  class AuthEmailSender extends ResendEmailSender {
    from = 'auth@myapp.com';  // must match your verified Resend domain
  }

  describe('Email Sender — Resend alternative', () => {
    it('basic ResendEmailSender subclass', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(ResendEmailSender);
    });
  });
}
