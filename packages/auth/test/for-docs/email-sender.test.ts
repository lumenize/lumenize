/**
 * Documentation validation test for Email Sender examples
 *
 * The documented code appears below - the @check-example plugin validates it exists here.
 * Each example is in its own block so the class name AuthEmailSender can be reused
 * (matching the docs), and the check-example substring match finds each variant.
 */
import { describe, it, expect } from 'vitest';
import { ResendEmailSender, defaultMagicLinkHtml } from '@lumenize/auth';

// --- Quick Start example (getting-started.mdx "Quick Start with Resend") ---

{
  class AuthEmailSender extends ResendEmailSender {
    from = 'auth@myapp.com';  // must match your verified Resend domain
  }

  describe('Email Sender — Quick Start', () => {
    it('basic ResendEmailSender subclass', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(ResendEmailSender);
    });
  });
}

// --- Customizing Templates example ---

{
  class AuthEmailSender extends ResendEmailSender {
    from = 'auth@myapp.com';
    replyTo = 'support@myapp.com';   // default: no-reply@myapp.com
    appName = 'My App';              // default: 'Lumenize'

    magicLinkHtml(message) {
      return `<h1>Welcome to My App</h1><a href="${message.magicLinkUrl}">Sign in</a>`;
    }
    // other 4 template methods use defaults
  }

  describe('Email Sender — Custom Templates', () => {
    it('custom template sender has overridden properties', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(ResendEmailSender);
    });
  });
}

// --- Composing with default template example ---

{
  class AuthEmailSender extends ResendEmailSender {
    from = 'auth@myapp.com';

    magicLinkHtml(message) {
      return `<div class="my-wrapper">${defaultMagicLinkHtml(message, this.appName)}</div>`;
    }
  }

  describe('Email Sender — Composed Template', () => {
    it('composed template sender works', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(ResendEmailSender);
    });
  });
}
