import { mesh } from '@lumenize/mesh/client';
import { NebulaClient } from './nebula-client';
import type { NebulaClientConfig } from './nebula-client';
import { DEFAULT_CHAT_ID, CHAT_NODE_ID } from './chat-constants';
import type { TransactionResult } from './snapshots';
import type { Galaxy } from './galaxy';

export interface StudioClientConfig extends NebulaClientConfig {
  /**
   * Invoked when the Galaxy answers a build this client asked for — the
   * {@link StudioClient.handlePreviewReady} push, fired by the build reply
   * (`Galaxy.announceBuildToRequester`) and by nothing else. Studio uses it to
   * auto-refresh the preview iframe — no manual Reload. `scope` is the scope the
   * readiness is for (ignore if the UI has since switched scopes).
   */
  onPreviewReady?: (scope: string) => void;
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
 * thread, upload a profile picture, and hear that a build it asked for is ready.
 *
 * It lives in `apps/nebula` rather than beside `NebulaClient` because the Galaxy names the class it
 * pushes the build reply to, and `apps/nebula-studio-ui` depends on `apps/nebula`, never the
 * reverse. Studio gets one from the same factory a generated app calls, by passing the class:
 * `createNebulaClient({ Client: StudioClient, … })`.
 */
export class StudioClient extends NebulaClient {
  /** The chat host pair — NO default; a post throws when unset (see the config JSDoc). */
  #chatHostBinding?: string;
  #chatScope?: string;
  #onPreviewReady?: (scope: string) => void;
  /** The page this client was built for; `undefined` when the browser auto-detected it, and an
   *  upload then falls back to the current origin. */
  #baseUrl?: string;

  constructor(config: StudioClientConfig) {
    const { onPreviewReady, chatHostBinding, chatScope, ...nebulaConfig } = config;
    super(nebulaConfig);
    this.#chatHostBinding = chatHostBinding;
    this.#chatScope = chatScope;
    this.#onPreviewReady = onPreviewReady;
    this.#baseUrl = config.baseUrl;
  }

  /** A child from `impersonate()` chats where its parent does. `onPreviewReady` is the parent's UI
   *  handler and stays behind, as `onLoginRequired` does. */
  protected override childConfig(): StudioClientConfig {
    return { ...super.childConfig(), chatHostBinding: this.#chatHostBinding, chatScope: this.#chatScope };
  }

  /**
   * Upload a profile picture — the platform's first blob — and return its public URL.
   *
   * Upload ONLY, on purpose: the caller then writes the URL into the Profile with
   * {@link NebulaClient.updateMyProfile}, which REPLACES the public set, so the caller carries
   * nickname/name through (App.vue's editor does). Two steps rather than one keeps the write on the
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
   * `meta.actingToken` (`sub` + `profileId` from the writer's verified JWT), which is what makes
   * author spoofing impossible — a client-written `author`/`role` would be a second, forgeable
   * source of truth. Returns the client-minted message id (idempotency, ADR-010); the agent reply
   * links back to it via `replyTo`. Rides the `Message where chat==DEFAULT_CHAT_ID` query, so the
   * sender AND every other subscriber see it via the fanout (no optimistic echo).
   */
  async postUserMessage(content: string): Promise<string> {
    const { binding, scope } = this.#chatHost();
    const messageId = crypto.randomUUID();
    const newETag = crypto.randomUUID();
    // The door's `transaction` returns an OntologyStaleError as a VALUE on a version
    // mismatch; everything else is the ordinary TransactionResult.
    const result = await this.lmz.callAsync(
      binding, scope,
      this.ctn<Galaxy>().resources.transaction(this.requireOntologyVersion('postUserMessage'), newETag, {
        [messageId]: {
          op: 'create', typeName: 'Message', nodeId: CHAT_NODE_ID,
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

  /**
   * Receive the Galaxy's build reply — "your preview has a new dist" (direct delivery,
   * addressed to this client's `instanceName`, so it survives a WS reconnect during the
   * build). Invokes the `onPreviewReady` hook so the UI can refresh the preview iframe.
   * `@mesh()`-decorated because it arrives as a push like the others.
   */
  @mesh()
  handlePreviewReady(scope: string): void {
    this.#onPreviewReady?.(scope);
  }
}
