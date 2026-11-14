/**
 * How Studio carries a run request to one of its preview tabs and answers with what the page said.
 *
 * The agent's `run_in_tab` reaches a person's Studio, and Studio holds the frames: "me", the
 * person's own page on the dev Star, and one for each persona of the cast. This is the part that
 * decides, with the frames behind a {@link TabPort}, so every arm is a test's to pin and App.vue
 * only posts, loads and listens (`calibration.md` §12).
 *
 * A run goes like this. The frame is loaded if it is not, and reloaded while its page has no
 * session, which is how a persona's tab is until its invite's mail has been accepted. Once the
 * page says it has a client (`lumenize:loaded`), the request is posted, and the page's answer
 * (`lumenize:ran`) ends the run. A run that is not answered inside its bound fails, and the failure
 * says which of those it was waiting for.
 */
import type { RunAnswer } from '@lumenize/resources/frontend';

/** The tab every Studio has: the person's own page on the dev Star's host. */
export const ME_TAB = 'me';

/** How long a run may take from Studio's side, the frame's load included. */
export const TAB_RUN_BOUND_MS = 20_000;

/** How long Studio waits before loading a tab again whose page had no session. */
export const NO_SESSION_RETRY_MS = 2_000;

/** What a {@link TabRunner} asks of the frames. */
export interface TabPort {
  /** Whether `tab`'s frame exists. */
  isLoaded(tab: string): boolean;
  /** Create `tab`'s frame, which loads its page. */
  load(tab: string): void;
  /** Load `tab`'s page again. */
  reload(tab: string): void;
  /** Post `message` to `tab`'s page. */
  post(tab: string, message: { type: 'lumenize:run'; id: string; code: string }): void;
}

interface PendingRun {
  tab: string;
  code: string;
  posted: boolean;
  settle: (outcome: RunAnswer | Error) => void;
}

/** What a frame's page posted, as App.vue reads it off a `message` event from that frame. */
export type TabMessage =
  | { type: 'lumenize:loaded'; id?: unknown }
  | { type: 'lumenize:login-required' }
  | { type: 'lumenize:ran'; id?: unknown; ok?: unknown; value?: unknown; error?: unknown; noSession?: unknown };

export class TabRunner {
  #port: TabPort;
  #tabs: () => string[];
  #timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  #newId: () => string;
  /** Tabs whose page has said it has a client, since its last load. */
  #ready = new Set<string>();
  /** Tabs whose page last said it has no session, each with the page's own words when it gave any. */
  #noSession = new Map<string, string | undefined>();
  #pending = new Map<string, PendingRun>();
  #retries = new Map<string, unknown>();

  constructor(port: TabPort, opts: {
    /** Every tab there is now: "me", then the cast's slugs. */
    tabs: () => string[];
    timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
    newId?: () => string;
  }) {
    this.#port = port;
    this.#tabs = opts.tabs;
    this.#timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as never) };
    this.#newId = opts.newId ?? (() => crypto.randomUUID().slice(0, 8));
  }

  /**
   * Run `code` in `tab`'s page and answer with what the page said: the code's value, or the error
   * it threw. Rejects when nothing ran it, with an Error that says where it stopped.
   */
  run(tab: string, code: string): Promise<RunAnswer> {
    const tabs = this.#tabs();
    if (!tabs.includes(tab)) {
      return Promise.reject(new Error(`There is no tab "${tab}". The tabs are: ${tabs.join(', ')}. A persona gets a tab once docs/personas.md names it under "The cast".`));
    }
    return new Promise<RunAnswer>((resolve, reject) => {
      const id = this.#newId();
      const bound = this.#timers.set(() => {
        this.#pending.delete(id);
        reject(new Error(this.#whyUnanswered(tab)));
      }, TAB_RUN_BOUND_MS);
      this.#pending.set(id, {
        tab, code, posted: false,
        settle: (outcome) => {
          this.#timers.clear(bound);
          this.#pending.delete(id);
          if (outcome instanceof Error) reject(outcome); else resolve(outcome);
        },
      });
      if (!this.#port.isLoaded(tab)) {
        this.#ready.delete(tab);
        this.#port.load(tab);
      } else if (this.#ready.has(tab)) {
        this.#post(id);
      }
    });
  }

  /** A frame's page posted `message`. App.vue calls this for every message it accepts from a frame. */
  onMessage(tab: string, message: TabMessage): void {
    if (message.type === 'lumenize:loaded') {
      // A fresh load's, or an echo of a reload request: either way a client is there to ask.
      this.#ready.add(tab);
      for (const [id, run] of this.#pending) if (run.tab === tab) this.#post(id);
      return;
    }
    if (message.type === 'lumenize:login-required') {
      this.#sessionMissing(tab, undefined);
      return;
    }
    const run = typeof message.id === 'string' ? this.#pending.get(message.id) : undefined;
    if (!run || run.tab !== tab) return;
    if (message.noSession === true) {
      // The page could not connect, so nothing ran. It may be a persona not accepted yet: wait and
      // load it again, and post the request to the page that comes back.
      run.posted = false;
      this.#sessionMissing(tab, typeof message.error === 'string' ? message.error : undefined);
      return;
    }
    this.#noSession.delete(tab);
    run.settle(message.ok === true
      ? { ok: true, value: message.value }
      : { ok: false, error: typeof message.error === 'string' ? message.error : 'the page gave no reason' });
  }

  /** A frame was removed or pointed elsewhere, so its page's last word no longer stands. */
  forget(tab: string): void {
    this.#ready.delete(tab);
    this.#noSession.delete(tab);
  }

  #post(id: string): void {
    const run = this.#pending.get(id);
    if (!run || run.posted) return;
    run.posted = true;
    this.#port.post(run.tab, { type: 'lumenize:run', id, code: run.code });
  }

  #sessionMissing(tab: string, why: string | undefined): void {
    this.#ready.delete(tab);
    this.#noSession.set(tab, why ?? this.#noSession.get(tab));
    const waiting = [...this.#pending.values()].some((run) => run.tab === tab);
    if (!waiting || this.#retries.has(tab)) return;
    this.#retries.set(tab, this.#timers.set(() => {
      this.#retries.delete(tab);
      if ([...this.#pending.values()].some((run) => run.tab === tab)) this.#port.reload(tab);
    }, NO_SESSION_RETRY_MS));
  }

  #whyUnanswered(tab: string): string {
    const seconds = TAB_RUN_BOUND_MS / 1000;
    if (this.#noSession.has(tab)) {
      const said = this.#noSession.get(tab);
      return tab === ME_TAB
        ? `Your own tab had no session on the dev Star for ${seconds} s${said ? ` (${said})` : ''}.`
        : `"${tab}" is not a member of the dev Star yet${said ? ` (${said})` : ''}. Invite it from the "me" tab at the address \`await client.personaAddress('${tab}')\` gives, then try again: its invite is accepted a few seconds after it is sent.`;
    }
    return this.#ready.has(tab)
      ? `The tab "${tab}" did not answer in ${seconds} s. The code may still be running there.`
      : `The tab "${tab}" did not answer in ${seconds} s: its page never said it has a client. Only a page whose app imports ./nebula can be asked to run code.`;
  }
}
