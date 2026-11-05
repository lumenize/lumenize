// Re-sends Cloudflare's destination-address verification to an address routed to email-test,
// catches the email, and follows its link. Prints only the link's host and path, never its token.
// Usage: npx tsx verify-address.mts <email> [<existing-address-id-to-delete-first>]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { waitForEmail } from '../../tooling/email-test/src/client.ts';

const [email, staleId] = process.argv.slice(2);
if (!email) throw new Error('usage: verify-address.mts <email> [stale-id]');
const devVars = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
const testToken = /^TEST_TOKEN=(.*)$/m.exec(devVars)?.[1]?.trim().replace(/^"|"$/g, '')!;
const wrangler = new URL('../../apps/nebula/node_modules/.bin/wrangler', import.meta.url).pathname;
const run = (...args: string[]) =>
  execFileSync(wrangler, args, { encoding: 'utf8', cwd: new URL('.', import.meta.url).pathname })
    .split('\n').filter((l) => !/WARNING|wrangler 4\.|^─+$|^\s*$/.test(l)).join('\n');

const waiter = waitForEmail({ testToken, to: email, timeout: 120_000 });
try {
  await new Promise((r) => setTimeout(r, 1500));
  if (staleId) console.log('delete:', run('email', 'routing', 'addresses', 'delete', staleId));
  console.log('create:', run('email', 'routing', 'addresses', 'create', email));
  const mail = await waiter.emailPromise;
  console.log('received:', mail.subject, 'from', JSON.stringify(mail.from));
  const body = `${mail.html ?? ''}\n${mail.text ?? ''}`;
  const links = [...new Set([...body.matchAll(/https:\/\/[^\s"'<>)]+/g)].map((m) => m[0].replace(/&amp;/g, '&')))];
  for (const l of links) { const u = new URL(l); console.log('  link:', u.host + u.pathname); }
  const verify = links.find((l) => /verif/i.test(l));
  if (!verify) throw new Error('no verification link found');
  // dash.cloudflare.com answers a script-free client with a bot challenge, so a person opens it.
  const out = process.env.VERIFY_LINK_FILE;
  if (!out) throw new Error('set VERIFY_LINK_FILE to save the link for a person to open');
  writeFileSync(out, verify + '\n');
  console.log('saved the verification link to', out);
} finally {
  waiter.cleanup();
}
