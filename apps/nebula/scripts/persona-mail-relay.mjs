#!/usr/bin/env node
/**
 * The local stack's persona mail relay: hand each message for a persona's address to the local
 * Worker's `email` handler, exactly as it arrived.
 *
 * A persona's invite is accepted by the Worker's `email` handler (`src/entrypoint.ts`), which
 * Cloudflare runs when a zone's catch-all rule routes mail to the Worker. No mail can be routed to a
 * Worker on `localhost`. So a local stack names the test mailbox's zone as its persona mail domain
 * (`LOCAL_PERSONA_MAIL_DOMAIN` in `local-config.mjs`), its invites arrive at the `email-test` Worker
 * like every other test mail, and this relay reads them there and posts each one's bytes to
 * `wrangler dev`'s own trigger for a local `email` handler, `POST /cdn-cgi/local/email`.
 *
 * ⚠️ It rewrites nothing, and that is what makes it a part of the local stack and not a harness
 * helper standing in for the code under test (`live-scenarios.md`): the handler reads the same
 * bytes, the same recipient and the same header it reads in production, and decides everything.
 * The stack starts it, in both `npm run dev` and the `/live` harness, and no scenario calls it.
 *
 * The test mailbox is shared by every run, so this relay hears other stacks' persona mail too.
 * The handler drops it: a link's token is known only to the Registry that issued it.
 *
 * CLI:    node scripts/persona-mail-relay.mjs -- <command…>   runs the command with the relay beside it
 * Import: startPersonaMailRelay({ workerUrl, testToken, mailDomain, log }) → { stop }
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_PERSONA_MAIL_DOMAIN } from './local-config.mjs';

const EMAIL_TEST_WS_URL = 'wss://email-test.transformation.workers.dev';

/**
 * @param {{ workerUrl: string, testToken: string, mailDomain?: string, log?: (line: string) => void }} opts
 *   `workerUrl` is `wrangler dev`'s own address, since the trigger is wrangler's and no proxy forwards it.
 * @returns {{ stop: () => void }} `stop` closes the socket, which otherwise keeps the process alive.
 */
export function startPersonaMailRelay({ workerUrl, testToken, mailDomain = LOCAL_PERSONA_MAIL_DOMAIN, log = () => {} }) {
  let stopped = false;
  let ws;
  let retry;
  // When the relay last had no socket, so a new one can ask the mailbox to replay that stretch.
  let downSince;
  // What has been handed on already: a replay sends again whatever arrived in the stretch it covers.
  const relayed = new Set();
  const relay = async (mail) => {
    // A delivery event has no `raw`, and neither has mail a mailbox from before it kept one.
    if (typeof mail?.raw !== 'string') return;
    const key = `${mail.messageId ?? ''}|${mail.receivedAt ?? ''}`;
    if (relayed.has(key)) return;
    relayed.add(key);
    for (const { address } of mail.to ?? []) {
      const to = String(address ?? '').toLowerCase();
      // Only what is shaped as a persona's address, which keeps every other test's login mail out
      // of the Worker's log. Whether it IS a persona's is the handler's to say.
      if (!to.endsWith(`@${mailDomain}`) || !to.split('@')[0].includes('--')) continue;
      const url = new URL('/cdn-cgi/local/email', workerUrl);
      url.searchParams.set('from', mail.from?.address ?? 'unknown@invalid');
      url.searchParams.set('to', to);
      try {
        const res = await fetch(url, { method: 'POST', body: Buffer.from(mail.raw, 'base64') });
        log(`[persona-mail-relay] ${to} → ${res.status}`);
      } catch (e) {
        log(`[persona-mail-relay] ${to} not delivered: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  const connect = () => {
    if (stopped) return;
    // The second of slack covers mail the mailbox stored just before this side saw the close.
    const replay = downSince === undefined ? '' : `&replayMs=${Date.now() - downSince + 1000}`;
    ws = new WebSocket(`${EMAIL_TEST_WS_URL}/ws?token=${testToken}${replay}`);
    ws.addEventListener('open', () => { downSince = undefined; });
    ws.addEventListener('message', (event) => {
      let mail;
      try { mail = JSON.parse(String(event.data)); } catch { return; }
      void relay(mail);
    });
    // A deploy of the mailbox, or an idle timeout, closes the socket. The next one asks the mailbox
    // to replay what arrived since, so an invite sent in that stretch is still handed on.
    ws.addEventListener('close', () => {
      downSince ??= Date.now();
      if (!stopped) retry = setTimeout(connect, 1000);
    });
    ws.addEventListener('error', () => { /* `close` follows */ });
  };
  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
}

/** `TEST_TOKEN` from the gitignored root `.dev.vars`, or `undefined`. */
function readTestToken() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    const line = readFileSync(resolve(root, '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith('TEST_TOKEN='));
    return line?.slice('TEST_TOKEN='.length).trim().replace(/^"|"$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--');
  const command = at === -1 ? [] : process.argv.slice(at + 1);
  if (command.length === 0) {
    console.error('usage: node scripts/persona-mail-relay.mjs -- <command…>');
    process.exit(2);
  }
  const testToken = readTestToken();
  const relay = testToken
    ? startPersonaMailRelay({
      workerUrl: process.env.PERSONA_RELAY_WORKER_URL ?? 'http://localhost:8787',
      testToken,
      log: (line) => console.error(line),
    })
    : undefined;
  if (!relay) console.error('[persona-mail-relay] no TEST_TOKEN in .dev.vars: personas\' invites will not be accepted on this stack');
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => {
    relay?.stop();
    process.exit(code ?? (signal ? 1 : 0));
  });
}
