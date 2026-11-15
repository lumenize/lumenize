/**
 * Mail for an address at the persona mail domain that is no persona's is rejected, so its sender
 * hears that no such mailbox exists; mail for a persona that carries nothing to accept is dropped
 * in silence (`entrypoint.ts`'s `email` handler).
 *
 * In-lane, with a message built by hand: its `to`, its headers, and a `setReject` that records.
 * No lane here delivers mail to the Worker as a message. Cloudflare routes it only to a deployed
 * Worker, and the local stack's relay hands over a persona's mail alone. What the handler decides
 * for a persona's own invite is `persona-mail.test.ts`'s in Mesh and the `/live` scenario
 * `persona-host`'s; this file holds the one line between that decision and the sender.
 */
import { describe, it, expect } from 'vitest';
import entrypoint from './index';

/** Hand `to` a message with no link in it, and answer what the handler told its sender. */
async function rejectionsFor(to: string): Promise<string[]> {
  const rejected: string[] = [];
  await (entrypoint as unknown as { email(message: unknown): Promise<void> }).email({
    to, headers: new Headers(), setReject: (reason: string) => { rejected.push(reason); },
  });
  return rejected;
}

describe("mail at the persona mail domain", () => {
  // Mutations: drop the `setReject` → the stranger's sender hears nothing; reject whatever was
  // not accepted → the persona's sender is told its mailbox does not exist.
  it("is rejected for an address that is no persona's, and dropped in silence for a persona's with nothing to accept", async () => {
    expect(await rejectionsFor('someone@personas.example')).toEqual(['No such address']);
    expect(await rejectionsFor('gerry--dev.first.acme@personas.example')).toEqual([]);
  });
});
