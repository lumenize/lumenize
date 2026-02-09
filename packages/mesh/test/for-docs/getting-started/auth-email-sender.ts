import { ResendEmailSender } from '@lumenize/auth';

export class AuthEmailSender extends ResendEmailSender {
  from = 'auth@example.com';
}
