/**
 * Nebula-branded email sender.
 *
 * Extends ResendEmailSender with Nebula branding.
 * Customize templates in follow-on work (see tasks/nebula-auth.md § Email Template Customization).
 */
import { ResendEmailSender } from '@lumenize/auth';

export class NebulaEmailSender extends ResendEmailSender {
  from = 'auth@nebula.lumenize.com';
  appName = 'Nebula';
}
