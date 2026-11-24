import { NebulaClient } from '@lumenize/resources/client';
import { mesh } from '@lumenize/mesh/client';
import type { RunAnswer } from '@lumenize/resources/frontend';
import type { CastEntry } from './cast';
import type { NebulaClientConfig } from '@lumenize/resources/client';
import { DEFAULT_CHAT_ID, MESSAGES_NODE_ID } from './chat-constants';
import type { TransactionResult } from '@lumenize/resources/client';
import type { Galaxy } from './galaxy';

export interface StudioClientConfig extends NebulaClientConfig {
  /**
   * The CHAT host pair — which binding + instance host this client's chat
   * ({@link StudioClient.postUserMessage}). Chat `Chat`/`Message` Resources live on
   * **GALAXY `{u}.{g}`** (the app-level brain) while app resources stay on the Star, so
   * the two planes are separate construction pairs — PER CLIENT INSTANCE, never per op.
   *
   * ⚠️ NO default, deliberately — a post with the pair unset THROWS loudly, which is what
   * kills the silent misroute (chat falling back to the resource pair would write the user
   * `Message` to the Star's plane). `Profile` subs ride NEITHER pair (the fixed `PROFILE`
   * binding with the profileId as instance, ADR-012).
   */
  chatHostBinding?: string;
  /** The chat host's instance — the galaxy `{u}.{g}` (see {@link chatHostBinding}). */
  chatScope?: string;
}

/**
 * Studio's own Client: a {@link NebulaClient} plus what only Studio does — post to the build
 * thread and upload a profile picture. A build that lands reaches Studio as a `ServedBuild` on the
 * chat, which every Studio on the app subscribes to through the ordinary query, so this class
 * hears no push of its own.
 *
 * It lives in `apps/nebula` rather than beside `NebulaClient` because posting is Nebula's chat:
 * it writes a `Message` at `DEFAULT_CHAT_ID` under `MESSAGES_NODE_ID`, which `@lumenize/resources`
 * may not import (`mesh.md` § *Package dependency direction*). Studio gets one from the same
 * factory a generated app calls, by passing the class: `createNebulaClient({ Client: StudioClient, … })`.
 */
/** The `name` of the Error a {@link StudioClient} answers `runInTab` with when it shows no preview. */
export const NO_PREVIEW_ERROR = 'NoPreviewError';

export class StudioClient extends NebulaClient {
  /** The chat host pair — NO default; a post throws when unset (see the config JSDoc). */
  #chatHostBinding?: string;
  #chatScope?: string;
  /** The page this client was built for; `undefined` when the browser auto-detected it, and an
   *  upload then falls back to the current origin. */
  #baseUrl?: string;
  /** How this Studio runs code in one of its preview tabs, set by the page that holds the frames. */
  #runInTab?: (tab: string, code: string) => Promise<RunAnswer>;

  constructor(config: StudioClientConfig) {
    const { chatHostBinding, chatScope, ...nebulaConfig } = config;
    super(nebulaConfig);
    this.#chatHostBinding = chatHostBinding;
    this.#chatScope = chatScope;
    this.#baseUrl = config.baseUrl;
  }

  /** A child from `impersonate()` chats where its parent does. */
  protected override childConfig(): StudioClientConfig {
    return { ...super.childConfig(), chatHostBinding: this.#chatHostBinding, chatScope: this.#chatScope };
  }

  /**
   * The cast the app's `docs/personas.md` names: each persona's slug and name, which Studio's
   * preview turns into a tab per persona. Read at the chat floor, as everyone who sees the tabs is
   * there; an app whose file names no cast answers an empty list.
   */
  async readCast(): Promise<CastEntry[]> {
    const { binding, scope } = this.#chatHost();
    return await this.lmz.callAsync(binding, scope, this.ctn<Galaxy>().readCast()) as CastEntry[];
  }

  /** Say how this Studio runs code in a preview tab. The page holding the frames calls it once. */
  setRunInTab(handler: (tab: string, code: string) => Promise<RunAnswer>): void {
    this.#runInTab = handler;
  }

  /**
   * Run `code` in one of this Studio's preview tabs and answer with what the page said. The
   * Galaxy calls it for the agent's `run_in_tab`, on a Studio tab of the person whose post the
   * turn took up, so the code runs with that person's own session, or a persona's they opened.
   *
   * `@mesh()`-decorated because a node calls it. No other Client can: a Client refuses a call whose
   * last hop is a Client (`MeshClient.onBeforeCall`). It throws, which the Galaxy hears as the
   * call's failure, when this Studio has no preview or the tab does not answer in time.
   */
  @mesh()
  runInTab(tab: string, code: string): Promise<RunAnswer> {
    if (!this.#runInTab) {
      // Named, so the Galaxy can pass this client over for the person's next tab: a script's
      // client, or one made by `impersonate()`, shows no preview, and ran nothing.
      throw Object.assign(new Error('This Studio tab is not showing a preview, so it has no tab to run code in'), { name: NO_PREVIEW_ERROR });
    }
    return this.#runInTab(tab, code);
  }

  /**
   * Upload a profile picture — the platform's first blob — and return its public URL.
   *
   * Upload ONLY, on purpose: the caller then writes the URL into the Profile with
   * {@link NebulaClient.patchMyProfile}, which changes only the fields it names (App.vue's
   * editor does). Two steps rather than one keeps the write on the
   * one owner-authorized path that already exists, instead of widening the auth Worker's seam.
   * The bearer never leaves the client (`authedFetch`); the server derives WHOSE picture from the
   * verified claims and sniffs the bytes — the Content-Type sent here is a courtesy.
   */
  async uploadProfilePicture(image: Blob): Promise<string> {
    const base = this.#baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : '');
    const res = await this.authedFetch(`${base}/pictures`, {
      method: 'PUT', body: image, headers: image.type ? { 'content-type': image.type } : {},
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error_description?: string };
      throw new Error(body.error_description ?? `picture upload failed (${res.status})`);
    }
    return ((await res.json()) as { url: string }).url;
  }

  /**
   * The chat host pair, or a LOUD throw when unset — the guard that kills the silent
   * misroute (a post falling back to the resource pair would land the user `Message` on the
   * Star's plane and the chat's subscription would watch the wrong host). Construct the
   * client with `chatHostBinding: 'GALAXY', chatScope: '{u}.{g}'` to chat.
   */
  #chatHost(): { binding: string; scope: string } {
    if (!this.#chatHostBinding || !this.#chatScope) {
      throw new Error(
        'This client has no chat host: construct it with chatHostBinding + chatScope ' +
        "(chat lives on GALAXY at the {u}.{g} tier) — chat never falls back to the resource pair.",
      );
    }
    return { binding: this.#chatHostBinding, scope: this.#chatScope };
  }

  /**
   * Post a human `Message` to the build thread — a single atomic create on the CHAT host's data
   * plane (the chat pair — throws without one). The committed `Message` IS the codegen trigger:
   * the Galaxy's commit hook starts the turn under the poster's own authority, and completion
   * arrives on the `Message` subscription.
   *
   * ⚠️ Writes NO identity fields: attribution comes entirely from the server-stamped
   * `meta.recordedClaims` (`sub` + `profileId` from the writer's verified JWT), which is what makes
   * author spoofing impossible — a client-written `author`/`role` would be a second, forgeable
   * source of truth. Returns the client-minted message id (idempotency, ADR-010); the agent reply
   * links back to it via `replyTo`. Rides the `Message where chat==DEFAULT_CHAT_ID` query, so the
   * sender AND every other subscriber see it via the fanout (no optimistic echo).
   */
  async postUserMessage(content: string): Promise<string> {
    const { binding, scope } = this.#chatHost();
    const messageId = crypto.randomUUID();
    // The door's `transaction` returns an OntologyStaleError as a VALUE on a version
    // mismatch; everything else is the ordinary TransactionResult.
    const result = await this.lmz.callAsync(
      binding, scope,
      this.ctn<Galaxy>().resources.transaction(this.requireOntologyVersion('postUserMessage'), {
        [messageId]: {
          op: 'create', typeName: 'Message', nodeId: MESSAGES_NODE_ID,
          value: { chat: DEFAULT_CHAT_ID, content },
        },
      }),
    ) as TransactionResult | Error;
    if (result instanceof Error) throw result;
    if (!result.ok) {
      throw new Error(`postUserMessage failed: ${JSON.stringify(result.errors)}`);
    }
    return messageId;
  }
}
