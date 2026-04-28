/**
 * Nebula-branded email sender.
 *
 * Extends CloudflareEmailSender with Nebula branding.
 * Customize templates in follow-on work (see tasks/nebula-auth.md § Email Template Customization).
 */
import { CloudflareEmailSender } from '@lumenize/auth';

export class NebulaEmailSender extends CloudflareEmailSender {
  from = 'auth@nebula.lumenize.com';
  appName = 'Nebula';
}
