import { CloudflareEmailSender } from '@lumenize/auth';

export class AuthEmailSender extends CloudflareEmailSender {
  from = 'auth@example.com';
}
