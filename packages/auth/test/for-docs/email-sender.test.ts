/**
 * Documentation validation test for Email Sender examples.
 *
 * The documented code appears below — the @check-example plugin validates it exists here.
 * Each example is in its own block so the class name AuthEmailSender can be reused
 * (matching the docs), and the check-example substring match finds each variant.
 *
 * Provider is chosen by the environment, not by which class you extend: the `EMAIL`
 * binding selects Cloudflare; `EMAIL_PROVIDER=resend` (+ `RESEND_API_KEY`) selects Resend.
 */
import { describe, it, expect } from 'vitest';
import {
  AuthEmailSenderBase,
  defaultMagicLinkHtml,
} from '@lumenize/auth';

// --- Quick Start (getting-started.md "Email Provider") ---

{
  class AuthEmailSender extends AuthEmailSenderBase {
    from = 'auth@myapp.com';  // a domain onboarded to Cloudflare Email Sending (or verified with Resend)
  }

  describe('Email Sender — Quick Start', () => {
    it('basic AuthEmailSenderBase subclass', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(AuthEmailSenderBase);
    });
  });
}

// --- Customizing Templates (customizing-email.mdx) ---

{
  class AuthEmailSender extends AuthEmailSenderBase {
    from = 'auth@myapp.com';
    replyTo = 'support@myapp.com';   // default: no-reply@myapp.com
    appName = 'My App';              // default: 'Lumenize'

    magicLinkHtml(message: any) {
      return `<h1>Welcome to My App</h1><a href="${message.magicLinkUrl}">Sign in</a>`;
    }
    // other 4 template methods use defaults
  }

  describe('Email Sender — Custom Templates', () => {
    it('custom template sender has overridden properties', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(AuthEmailSenderBase);
    });
  });
}

// --- Composing with the default template (customizing-email.mdx) ---

{
  class AuthEmailSender extends AuthEmailSenderBase {
    from = 'auth@myapp.com';

    magicLinkHtml(message: any) {
      return `<div class="my-wrapper">${defaultMagicLinkHtml(message, this.appName)}</div>`;
    }
  }

  describe('Email Sender — Composed Template', () => {
    it('composed template sender works', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(AuthEmailSenderBase);
    });
  });
}

// --- Using Resend (using-resend-instead.mdx) ---
// Same base class — Resend is selected by env (EMAIL_PROVIDER=resend, or no EMAIL
// binding, + RESEND_API_KEY), not by extending a different class.

{
  class AuthEmailSender extends AuthEmailSenderBase {
    from = 'auth@myapp.com';  // must match your verified Resend domain
  }

  describe('Email Sender — Resend via EMAIL_PROVIDER', () => {
    it('same base class; provider chosen by env', () => {
      expect(AuthEmailSender.prototype).toBeInstanceOf(AuthEmailSenderBase);
    });
  });
}
