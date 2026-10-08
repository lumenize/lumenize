<script setup lang="ts">
/**
 * Home — where a person chooses what to enter, and consents to each membership.
 *
 * Home lives on the platform host, which holds a refresh cookie per membership and gives a page no
 * token. So it reads one route, `POST /auth/home-summary`, authenticated by those cookies: a summary
 * per Profile they resolve to, the scopes of the cookies whose memberships are still pending, and the
 * scope and admin bit of each live cookie it read. One browser can hold several people's sessions, so
 * each Profile gets a card of its own.
 *
 * Home acts on nothing. Every row links to the host that can act on it: entering a scope, adding an
 * app on its account's page, deleting an account there. Its only requests are the summary and the
 * consent pair, which live on this host because they are about the cookies.
 *
 * ⚠️ **A row's decisions are NOT made in this template.** Which modal a row opens, whether it is
 * clickable, whether it needs a fresh login, and whether the whole screen fast-forwards all come from
 * `home-logic.ts`, so they are assertable. See that file's header for why.
 *
 * **Every move into a scope's host waits for that host to answer** (`HostWait`). A ticket-backed
 * signup is accepted here and then fast-forwards into its new app (`afterAcceptTarget`), whose
 * certificate is still being issued, so the count-up shows instead of a certificate error.
 *
 * ⚠️ **Accept re-reads the summary before it navigates or re-renders.** Taking up a membership can
 * change what the tree contains rather than just how one row looks — accepting the platform root
 * reveals its first level of descendants, which were withheld while the membership was unaccepted —
 * so patching the row in place would leave the screen showing a tree the server no longer agrees
 * with.
 */
import { leaveTo, scopeUrl, platformUrl } from '../view-state';
import { ref, onMounted, computed } from 'vue';
import { Plus, Trash2 } from 'lucide-vue-next';
import ConsentModal from './ConsentModal.vue';
import HostWait from '../HostWait.vue';
import {
  modalFlavorFor, surfaceFor, rendersExpanded, homeFastForward, afterAcceptTarget, needsFreshLogin, offersAccountActions, offersAppDelete,
  type HomeSummary, type ScopeNode,
} from './home-logic';

/**
 * Read and discard a response body so the load completes.
 *
 * ⚠️ **Not hygiene — this is what stops a PHANTOM network error.** A `fetch` whose body is never
 * read leaves the load open for Chromium to cancel, which surfaces as `net::ERR_ABORTED` on a
 * request that actually succeeded. Anything watching the network then cannot tell it from a real
 * failure, which would force a blanket "ignore failed requests" filter and blind the very check
 * that catches a screen quietly 404ing its own bundle (`harness/scenarios/auth-pages-render.ts`).
 */
const drain = (resp: Response) => resp.text().catch(() => { /* nothing to drain is fine */ });

const home = ref<HomeSummary | undefined>();
const error = ref('');
const loading = ref(true);
const pending = ref<ScopeNode | undefined>(); // the row whose modal is open
/** The display names already on file, handed to the consent modal to pre-fill. Kept beside
 *  `pending` rather than on the node: they belong to the PERSON, not to the membership. */
const pendingNickname = ref('');
const pendingName = ref('');
const accepting = ref(false);
/** The app this page is entering once its host answers. */
const waitingFor = ref<string | undefined>();

/**
 * Pending memberships no summary lists — the browser holds their cookies but no accepted one that
 * reaches the same Profile, as after a signup or a first invite. Each still needs its consent.
 */
const orphanPending = computed<ScopeNode[]>(() => {
  const listed = new Set((home.value?.groups ?? [])
    .flatMap((g) => g.summary.emails.flatMap((e) => e.memberships.map((m) => m.scope))));
  return (home.value?.pending ?? []).filter((scope) => !listed.has(scope)).map((scope) => {
    const depth = scope.split('.').length;
    return { scope, tier: depth === 1 ? 'universe' : depth === 2 ? 'galaxy' : 'star', accepted: false } as ScopeNode;
  });
});

/** Whether a row this browser could not open from here should say so. Pending rows go to consent. */
const marked = (m: ScopeNode) => m.accepted !== false && needsFreshLogin(m, home.value?.held ?? []);


/** `POST` a route on this host, as a page here does. */
function post(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** The summary, or `undefined` when no cookie of this browser covers anything. */
async function loadHome(): Promise<HomeSummary | undefined> {
  const resp = await post('/auth/home-summary');
  if (resp.status === 401) { await drain(resp); return undefined; }
  if (!resp.ok) { await drain(resp); throw new Error(`home-summary ${resp.status}`); }
  return await resp.json() as HomeSummary;
}

/** The pending row's consent inputs: whether it came by invite, who sent it, the names to pre-fill. */
async function openConsent(node: ScopeNode) {
  const resp = await post('/auth/pending-membership', { scope: node.scope });
  if (resp.ok) {
    const card = await resp.json() as { invited?: boolean; invitedByName?: string; nickname?: string; name?: string };
    pendingNickname.value = card.nickname ?? '';
    pendingName.value = card.name ?? '';
    pending.value = {
      ...node,
      ...(card.invited ? { invited: true } : {}),
      ...(card.invitedByName !== undefined ? { invitedByName: card.invitedByName } : {}),
    };
  } else {
    await drain(resp);
    pending.value = node;
  }
}

/** Consent for a pending row; otherwise its host, through a fresh login when this browser holds no
 *  cookie that opens it. */
function openOrEnter(node: ScopeNode) {
  if (modalFlavorFor(node)) { void openConsent(node); return; }
  const surface = surfaceFor(node, (s) => scopeUrl(s));
  if (!surface) return;
  if (marked(node)) leaveTo(platformUrl(`/auth/login?return_to=${encodeURIComponent(surface)}`));
  else waitingFor.value = surface;
}

async function accept(names: { nickname: string; name?: string }) {
  if (!pending.value) return;
  const node = pending.value;
  accepting.value = true;
  let leaving = false;
  try {
    // The names ride the acceptance itself — one request, so a person cannot end up enrolled
    // somewhere while the name everyone will see them by failed to save separately.
    const resp = await post('/auth/accept-membership', { scope: node.scope, ...names });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({})) as { error_description?: string };
      error.value = body.error_description ?? 'Could not accept that. Try again.';
      pending.value = undefined;
      return;
    }
    await drain(resp);
    // Re-read rather than patch — see the header.
    home.value = await loadHome();
    pending.value = undefined;
    const target = afterAcceptTarget(home.value!, node, (s) => scopeUrl(s));
    if (target) { leaving = true; waitingFor.value = target; }
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    // A page on its way out stays busy, so Accept cannot be clicked again while the host is awaited.
    if (!leaving) accepting.value = false;
  }
}

onMounted(async () => {
  try {
    const loaded = await loadHome();
    if (!loaded) { leaveTo(platformUrl('/auth/login')); return; }
    home.value = loaded;

    // One accepted place to work and nothing else: they came to use it, not to choose between one option.
    const straightIn = homeFastForward(loaded, (s) => scopeUrl(s));
    if (straightIn) { waitingFor.value = straightIn; return; }

    // A lone pending membership and nothing else — a signup's, typically — opens its consent at
    // once: it is the only thing here to do.
    if (loaded.groups.length === 0 && orphanPending.value.length === 1) void openConsent(orphanPending.value[0]);
  } catch {
    error.value = 'Could not load your accounts.';
  } finally {
    // A fast-forward keeps "Loading…" up rather than flashing the list it is skipping.
    if (!waitingFor.value) loading.value = false;
  }
});
</script>

<template>
  <div class="w-full max-w-2xl mx-auto space-y-4">
    <HostWait v-if="waitingFor" :url="waitingFor" />

    <p v-if="loading" class="text-center text-base-content/70">Loading…</p>

    <div v-else-if="error" class="card bg-base-200">
      <div class="card-body items-center text-center">
        <p>{{ error }}</p>
        <a class="btn btn-primary btn-sm" href="/auth/login">Sign in</a>
      </div>
    </div>

    <template v-else>
      <div v-if="orphanPending.length" class="card bg-base-200" data-testid="home-pending">
        <div class="card-body">
          <ul class="space-y-1">
            <li v-for="m in orphanPending" :key="m.scope">
              <button class="btn btn-ghost btn-block justify-start" @click="openOrEnter(m)">
                <span class="font-mono">{{ m.scope }}</span>
                <span class="badge badge-warning badge-sm">Confirm</span>
              </button>
            </li>
          </ul>
        </div>
      </div>

      <!-- One card per Profile: each is one person's addresses and everything they hold. -->
      <div v-for="g in home?.groups ?? []" :key="g.profileId" class="card bg-base-200" data-testid="home-group">
        <div class="card-body space-y-3">
          <section v-for="section in g.summary.emails" :key="section.email" class="space-y-1">
            <h2 class="text-sm font-semibold text-base-content/70">{{ section.email }}</h2>

            <p v-if="section.memberships.length === 0" class="text-base-content/70">Nothing here yet.</p>

            <ul v-else class="space-y-1">
              <li v-for="m in section.memberships" :key="m.scope" data-testid="home-row" :data-scope="m.scope">
                <div class="flex items-center gap-1">
                  <button
                    class="btn btn-ghost flex-1 justify-start"
                    :disabled="!modalFlavorFor(m) && !surfaceFor(m, scopeUrl)"
                    @click="openOrEnter(m)"
                  >
                    <span class="font-mono">{{ m.scope }}</span>
                    <span v-if="modalFlavorFor(m)" class="badge badge-warning badge-sm">
                      {{ modalFlavorFor(m) === 'invite' ? 'Invitation' : 'Confirm' }}
                    </span>
                    <span v-else-if="marked(m)" class="badge badge-info badge-sm" data-testid="home-relogin">Sign in again</span>
                    <span v-else-if="m.childCount" class="badge badge-ghost badge-sm">{{ m.childCount }}</span>
                  </button>
                  <!-- An app's Studio deletes it; Home only links there. -->
                  <button v-if="offersAppDelete(m)" class="btn btn-ghost btn-sm btn-square" title="Delete this app"
                    data-testid="home-app-delete" @click="leaveTo(scopeUrl(m.scope, '/?app'))">
                    <Trash2 class="size-4" />
                  </button>
                  <!-- An account's own page does both; Home only links there. -->
                  <template v-if="offersAccountActions(m)">
                    <button class="btn btn-ghost btn-sm gap-1" title="Add an app" data-testid="home-add-app"
                      @click="leaveTo(scopeUrl(m.scope, '/?create'))">
                      <Plus class="size-4" /> App
                    </button>
                    <button class="btn btn-ghost btn-sm btn-square" title="Delete this account" data-testid="home-delete"
                      @click="leaveTo(scopeUrl(m.scope))">
                      <Trash2 class="size-4" />
                    </button>
                  </template>
                </div>

                <!-- Descendants, only for a membership that has been taken up (the server withholds
                     them otherwise), and only expanded while the level is small enough to read. -->
                <ul v-if="m.children && rendersExpanded(m.children)" class="pl-6 space-y-1">
                  <li v-for="c in m.children" :key="c.scope" data-testid="home-row" :data-scope="c.scope" class="flex items-center gap-1">
                    <button
                      class="btn btn-ghost btn-sm flex-1 justify-start"
                      :disabled="!surfaceFor(c, scopeUrl)"
                      @click="openOrEnter(c)"
                    >
                      <span class="font-mono">{{ c.scope }}</span>
                      <span v-if="marked(c)" class="badge badge-info badge-xs" data-testid="home-relogin">Sign in again</span>
                      <span v-else-if="c.childCount" class="badge badge-ghost badge-xs">{{ c.childCount }}</span>
                    </button>
                    <button v-if="offersAppDelete(c, m)" class="btn btn-ghost btn-xs btn-square" title="Delete this app"
                      data-testid="home-app-delete" @click="leaveTo(scopeUrl(c.scope, '/?app'))">
                      <Trash2 class="size-3" />
                    </button>
                  </li>
                </ul>
                <details v-else-if="m.children" class="pl-6">
                  <summary class="cursor-pointer text-sm text-base-content/70">
                    {{ m.children.length }} inside
                  </summary>
                  <ul class="space-y-1 pt-1">
                    <li v-for="c in m.children" :key="c.scope" data-testid="home-row" :data-scope="c.scope" class="flex items-center gap-1">
                      <button
                        class="btn btn-ghost btn-sm flex-1 justify-start"
                        :disabled="!surfaceFor(c, scopeUrl)"
                        @click="openOrEnter(c)"
                      >
                        <span class="font-mono">{{ c.scope }}</span>
                        <span v-if="marked(c)" class="badge badge-info badge-xs" data-testid="home-relogin">Sign in again</span>
                      </button>
                      <button v-if="offersAppDelete(c, m)" class="btn btn-ghost btn-xs btn-square" title="Delete this app"
                        data-testid="home-app-delete" @click="leaveTo(scopeUrl(c.scope, '/?app'))">
                        <Trash2 class="size-3" />
                      </button>
                    </li>
                  </ul>
                </details>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </template>

    <ConsentModal
      v-if="pending"
      :flavor="modalFlavorFor(pending)!"
      :scope="pending.scope"
      :invited-by-name="pending.invitedByName"
      :nickname="pendingNickname"
      :name="pendingName"
      :busy="accepting"
      @accept="accept"
      @decline="pending = undefined"
    />
  </div>
</template>
