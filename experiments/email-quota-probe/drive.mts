// Drives the probe Worker (`wrangler dev --port 8799`): for each case, arms an email-test waiter for
// the recipient, asks the binding to send, and reports whether the send was accepted and arrived.
import { readFileSync } from 'node:fs';
import { waitForEmail } from '../../tooling/email-test/src/client.ts';

const devVars = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
const testToken = /^TEST_TOKEN=(.*)$/m.exec(devVars)?.[1]?.trim().replace(/^"|"$/g, '');
if (!testToken) throw new Error('TEST_TOKEN missing from .dev.vars');

const rand = () => Math.random().toString(36).slice(2, 8);
const cases: Array<{ label: string; from: string; to: string; observable: boolean }> = [
  { label: 'sending domain → catch-all address', from: 'noreply@lumenize.io', to: `quota-probe-${rand()}@lumenize-test.dev`, observable: true },
  { label: 'routing-only domain → catch-all address', from: 'noreply@lumenize-test.dev', to: `quota-probe-${rand()}@lumenize-test.dev`, observable: true },
  { label: 'routing-only domain → verified test@lumenize.io', from: 'noreply@lumenize-test.dev', to: 'test@lumenize.io', observable: false },
  { label: 'routing-only domain → pending claude@lumenize.io', from: 'noreply@lumenize-test.dev', to: 'claude@lumenize.io', observable: true },
];

for (const c of cases) {
  const waiter = c.observable ? waitForEmail({ testToken, to: c.to, timeout: 25_000 }) : undefined;
  try {
    await new Promise((r) => setTimeout(r, 1500)); // let the waiter's socket open
    const res = await fetch(`http://127.0.0.1:8799/send?to=${encodeURIComponent(c.to)}&from=${encodeURIComponent(c.from)}`);
    const sent = (await res.json()) as { ok: boolean; error?: string };
    let arrived = 'not observable';
    if (waiter) {
      arrived = await waiter.emailPromise.then(() => 'ARRIVED', (e) => `no (${String(e?.message ?? e).slice(0, 60)})`);
    }
    console.log(`${c.label}\n  from ${c.from} to ${c.to}\n  send: ${sent.ok ? 'accepted' : `REFUSED: ${sent.error}`}\n  arrival: ${arrived}`);
  } finally {
    waiter?.cleanup();
  }
}
