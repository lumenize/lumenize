/**
 * What a Client does with a stale answer (ADR-024): one decision for every place one arrives — a
 * transaction's answer, a read's or a node invite's refusal, and the resource, query and roster
 * push channels — so the six cannot drift apart. Pure, so a table pins every pairing.
 */

/**
 * - `retry` — the host is asking what is current; send the op again shortly.
 * - `reload` — the answer names a version other than this page's, so the page is on an old build.
 * - `restore` — an install or a wipe dropped this page's subscriptions; subscribe again.
 * - `resolve` — nothing more to do: the op ends `ontology-stale`.
 */
export type StaleAction = 'retry' | 'reload' | 'restore' | 'resolve';

export interface StaleInput {
  /** A notice the host pushed after an install or a wipe, rather than the refusal of one of this
   *  page's ops. A refused subscribe arrives on the push channel too, so this rides the error. */
  notice: boolean;
  /** The host is asking what is current, so a retry may land. */
  checking: boolean;
  /** The op still has retries left. */
  retriesLeft: boolean;
  /** The version the answer names as current, or `''` for none. */
  named: string;
  /** The version this page was built against. */
  own: string | undefined;
  /** The version the reload guard last reloaded this tab for, if any. */
  reloadedFor: string | undefined;
}

/**
 * Anything naming another version reloads the page, once per version, so the guard stops only a
 * loop on that same version. A notice naming the page's own version, or none, means its
 * subscriptions were dropped, so it subscribes again. A refusal naming none restores nothing: on a
 * Star with nothing installed, every tenant before a publish, a restore would ask again and be
 * refused again every couple of seconds.
 */
export function decideStale(input: StaleInput): StaleAction {
  if (!input.notice && input.checking && input.retriesLeft) return 'retry';
  if (input.named !== '' && input.named !== input.own) {
    return input.reloadedFor === input.named ? 'resolve' : 'reload';
  }
  return input.notice ? 'restore' : 'resolve';
}
