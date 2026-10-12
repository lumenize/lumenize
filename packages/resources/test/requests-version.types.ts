/**
 * A type test, checked by `npm run type-check` and run by nothing: every op on data the ontology
 * types takes the version its page was built against, and leaving it out does not compile
 * (ADR-024). Each refused call passes `undefined` where the version goes and is otherwise its twin
 * above, which compiles, so the `@ts-expect-error` cannot be satisfied by some other error in the
 * line. A call that simply drops the version would not do: its query lands in the version's slot,
 * which fails to compile whether or not the version is required.
 *
 * Mutation: widen any of the three version parameters to `string | undefined`, and its marker reds
 * the type-check as an unused `@ts-expect-error`.
 */
import type { ResourcesRequests, NodeInvitee, QueryDescriptor } from '@lumenize/resources';

declare const requests: ResourcesRequests;
declare const query: QueryDescriptor;
declare const invitees: NodeInvitee[];

requests.subscribeQuery('v1', query);
// @ts-expect-error — a list subscription without the page's version
requests.subscribeQuery(undefined, query);

requests.subscribeQuerySubscribers('v1', query);
// @ts-expect-error — a roster subscription without the page's version
requests.subscribeQuerySubscribers(undefined, query);

void requests.invite('v1', 'node-1', invitees);
// @ts-expect-error — a node invite without the page's version
void requests.invite(undefined, 'node-1', invitees);
