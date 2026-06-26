/**
 * A fully-resolved email, ready for a transport to deliver. The caller (e.g.
 * `@lumenize/auth`'s `AuthEmailSenderBase`) assembles every field — template,
 * subject, headers — *before* handing it to a transport, so a transport's only
 * job is to remap these fields onto its provider's wire shape.
 */
export interface ResolvedEmail {
  to: string;
  subject: string;
  html: string;
  from: string;
  replyTo: string;
  appName: string;
  /** Custom headers, passed through verbatim to the provider. Empty `{}` by default. */
  headers: Record<string, string>;
}

/** A provider-agnostic email transport: deliver one fully-resolved email. */
export interface EmailTransport {
  sendEmail(email: ResolvedEmail): Promise<void>;
}
