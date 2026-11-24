/**
 * Two people in one app's chat, enrolled the way production enrols them: Jennifer by a real
 * email login that founds the app, and Austen by the real node invite, with `write` at the chat
 * node and no admin bit, followed as sent and accepted. Every step here is one a browser takes.
 */
import assert from 'node:assert/strict';
import { waitForEmail } from '@lumenize/email-test/client';
import type { NodeInviteAck } from '@lumenize/resources';
import { MESSAGES_NODE_ID, COLLABORATOR_GRANTS, CHAT_MESSAGE_ONTOLOGY_VERSION, StudioClient } from '@lumenize/nebula/client';
import type { Galaxy } from '@lumenize/nebula';
import type { DevStack, Driver } from './harness';
import { connectDriver } from './harness';
import { refreshAccessToken, refreshTokenForScope, setCookieHeaders, consumeLink } from '../../test/lib/email-login';

const uniqueTestEmail = () => `test-${crypto.randomUUID().slice(0, 8)}@lumenize-test.dev`;

export interface ChatCast {
  jennifer: Driver<StudioClient>;
  /** The address Jennifer signed in with, so a scenario can sign her in again in a browser. */
  jenniferEmail: string;
  austen: Driver<StudioClient>;
  /** The address Austen was invited at. */
  austenEmail: string;
  /** Austen's `sub`, as the server minted it. */
  austenSub: string;
  dispose(): void;
}

/** Found the app at `scope` as Jennifer, and bring Austen into its chat by invite. */
export async function chatCast(stack: DevStack, scope: string, testToken: string): Promise<ChatCast> {
  const origin = stack.baseUrl.replace(/\/$/, '');
  const jenniferEmail = uniqueTestEmail();
  const jennifer = await connectDriver(stack, { scope, Client: StudioClient, email: jenniferEmail });
  const drivers: Driver<StudioClient>[] = [jennifer];
  try {
    const austenEmail = uniqueTestEmail();
    const waiter = waitForEmail({ testToken, instance: scope, to: austenEmail, timeout: 60_000 });
    let austenRefresh: string;
    try {
      const ack = await jennifer.client.lmz.callAsync('GALAXY', scope,
        jennifer.client.ctn<Galaxy>().resources.invite(CHAT_MESSAGE_ONTOLOGY_VERSION, [{ email: austenEmail, grants: COLLABORATOR_GRANTS }])) as NodeInviteAck;
      assert.deepEqual(ack, { accepted: 1, errors: [] }, `invite ack: ${JSON.stringify(ack)}`);
      const mail = await waiter.emailPromise;
      const href = /href="([^"]*\/auth\/magic-link\?token=[^"]*)"/.exec(mail.html ?? '')?.[1];
      assert.ok(href, 'the invite email carried no accept link');
      const clicked = await consumeLink(href.replace(/&amp;/g, '&'), fetch, { nickname: 'Austen' });
      const found = refreshTokenForScope(setCookieHeaders(clicked), scope);
      assert.ok(found, `the acceptance set no cookie for the app (${clicked.status})`);
      austenRefresh = found;
    } finally {
      waiter.cleanup();
    }
    const session = await refreshAccessToken(origin, { refreshToken: austenRefresh, authScope: scope }, scope, fetch);
    const austen = await connectDriver(stack, { scope, Client: StudioClient, session });
    drivers.push(austen);
    return { jennifer, jenniferEmail, austen, austenEmail, austenSub: session.sub, dispose: () => { for (const d of drivers) d.dispose(); } };
  } catch (e) {
    for (const d of drivers) d.dispose();
    throw e;
  }
}
