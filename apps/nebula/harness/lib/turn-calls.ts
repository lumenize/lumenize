/**
 * A turn's calls, as a scenario reads them: from the rounds the turn's agent message names, read
 * once through the Client's own `resources.query`, as Studio reads them for its marks. An app's
 * admin reads them through dominion, and a collaborator through the `read` an invite at the chat
 * node brings at the turns node.
 */
import type { QueryDescriptor, QueryReadResult } from '@lumenize/resources';
import { roundsOf, turnCalls, type TurnCall } from '@lumenize/nebula/client';

export async function turnCallsOf(
  client: { resources: { query(query: QueryDescriptor): Promise<QueryReadResult> } },
  messageId: string,
): Promise<TurnCall[]> {
  return turnCalls((await client.resources.query(roundsOf(messageId))).snapshots);
}
