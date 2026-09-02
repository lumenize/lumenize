<script setup lang="ts">
/**
 * Home — where a proved address chooses what to enter, and consents to each membership.
 *
 * The bootstrap is a plain refresh at the scope the URL names: the click that landed here set one
 * cookie per membership, so exchanging the one for this scope gives a token that authenticates the
 * summary read. Everything else on the page comes from that single read — the addresses, the tree,
 * each row's acceptance state, and the inviter attribution the consent modal renders. There is no
 * second call.
 *
 * ⚠️ **A row's decisions are NOT made in this template.** Which modal a row opens, whether it is
 * clickable, and whether the whole screen fast-forwards all come from `home-logic.ts`, so they are
 * assertable. See that file's header for why.
 *
 * ⚠️ **Accept re-fetches the summary before it navigates or re-renders.** Taking up a membership can
 * change what the tree contains rather than just how one row looks — accepting the platform root
 * reveals its first level of descendants, which were withheld while the membership was unaccepted —
 * so patching the row in place would leave the screen showing a tree the server no longer agrees
 * with.
 */
import { ref, onMounted, computed } from 'vue';
import ConsentModal from './ConsentModal.vue';
import {
  modalFlavorFor, surfaceFor, rendersExpanded, fastForwardTarget, crossEmailNotice, authHintFor,
  type ScopeSummary, type ScopeNode, type EmailScopes,
} from './home-logic';

const props = defineProps<{ scope: string }>();

const summary = ref<ScopeSummary | undefined>();
const error = ref('');
const loading = ref(true);
const accessToken = ref('');
const pending = ref<ScopeNode | undefined>(); // the row whose modal is open
const accepting = ref(false);
const selectedEmail = ref('');

const sections = computed<EmailScopes[]>(() => summary.value?.emails ?? []);
const activeSection = computed(() =>
  sections.value.find((s) => s.email === selectedEmail.value) ?? sections.value[0]);

async function bootstrap() {
  const resp = await fetch(`/auth/${encodeURIComponent(props.scope)}/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeScope: props.scope }),
  });
  if (!resp.ok) throw new Error('needs-login');
  const { access_token } = await resp.json() as { access_token: string };
  accessToken.value = access_token;
}

/**
 * The consent modal's inputs when there is no session to read a summary with.
 *
 * ⚠️ **This is the ONLY path for a brand-new arrival, and missing it made the screen useless for
 * exactly the case it exists for.** A claim or invite 302 lands here holding one INERT cookie: the
 * refresh above refuses an unaccepted membership by design, so the bootstrap fails, so the summary
 * is unreachable, so the modal never renders — the person is told to sign in again on the screen
 * that was supposed to let them in. Found by driving it (`harness/scenarios/auth-pages-render.ts`);
 * the bootstrap order in the design predates inert-until-accepted and the two clauses collide.
 *
 * The endpoint is credentialed by the same cookie and resolves it server-side to its own membership.
 */
async function loadPendingCard(): Promise<ScopeNode | undefined> {
  const resp = await fetch(`/auth/${encodeURIComponent(props.scope)}/pending-membership`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) return undefined;
  const card = await resp.json() as
    { universeGalaxyStarId: string; accepted: boolean; invited?: boolean; invitedByName?: string };
  if (card.accepted) return undefined; // already taken up — nothing to consent to
  const depth = card.universeGalaxyStarId.split('.').length;
  return {
    scope: card.universeGalaxyStarId,
    tier: depth === 1 ? 'universe' : depth === 2 ? 'galaxy' : 'star',
    accepted: false,
    ...(card.invited ? { invited: true } : {}),
    ...(card.invitedByName !== undefined ? { invitedByName: card.invitedByName } : {}),
  };
}

async function loadSummary(): Promise<ScopeSummary> {
  const resp = await fetch('/auth/scope-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken.value}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`scope-summary ${resp.status}`);
  return await resp.json() as ScopeSummary;
}

function openOrEnter(node: ScopeNode) {
  const flavor = modalFlavorFor(node);
  if (flavor) { pending.value = node; return; }
  const surface = surfaceFor(node);
  if (surface) enter(node, surface);
}

/**
 * Navigate into a scope's own surface, leaving the destination the one fact it cannot derive.
 *
 * ⚠️ **The hint says WHICH COOKIE to spend, and that is not guessable from the destination URL.**
 * Studio at `/acme.crm` knows the scope it is working in; it does not know that the refresh
 * cookie authorizing it sits at `/auth/acme`, because a person's session is established at whatever
 * scope their link named — which here is the segment this very page bootstrapped from. Without the
 * hint Studio falls back to trying the active scope as its own auth scope, and for anyone who
 * entered below their membership that refresh is sent to a path holding no cookie.
 *
 * ⚠️ **The key and store are Studio's, not ours to choose** — `localStorage`, under
 * `nebula.authScope:{activeScope}`, which is what `App.vue`'s `authHint` reads. `NebulaClient`
 * rewrites the same entry on every successful token acquisition, so this is a seed for the first
 * load rather than a second source of truth.
 *
 * ⚠️ **Written BEFORE the navigation.** Written after, the navigation has already begun.
 */
function enter(node: ScopeNode, surface: string) {
  try {
    const hint = authHintFor(node.scope, props.scope);
    localStorage.setItem(hint.key, hint.value);
  } catch { /* private mode — Studio falls back to trying the active scope */ }
  window.location.assign(surface);
}

async function accept() {
  if (!pending.value) return;
  const node = pending.value;
  accepting.value = true;
  try {
    const resp = await fetch(`/auth/${encodeURIComponent(node.scope)}/accept-membership`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) { error.value = 'Could not accept that. Try again.'; return; }

    // Re-fetch rather than patch — see the header. This is also the moment a first-time arrival
    // gets a session at all: the cookie was inert until the Accept above, so the bootstrap that
    // failed on arrival succeeds now.
    accessToken.value = '';
    await bootstrap();
    summary.value = await loadSummary();
    selectedEmail.value = summary.value.emails.find((e) => e.current)?.email
      ?? summary.value.emails[0]?.email ?? selectedEmail.value;
    pending.value = undefined;

    const surface = surfaceFor(node);
    if (surface) enter(node, surface);
  } catch {
    error.value = 'Could not reach the server. Try again.';
  } finally {
    accepting.value = false;
  }
}

onMounted(async () => {
  try {
    await bootstrap();
    const loaded = await loadSummary();
    summary.value = loaded;
    selectedEmail.value = loaded.emails.find((e) => e.current)?.email ?? loaded.emails[0]?.email ?? '';

    // One accepted Star and nothing else: they came to use an app, not to choose between one option.
    const straightIn = fastForwardTarget(loaded);
    if (straightIn) {
      const only = loaded.emails.flatMap((e) => e.memberships)[0];
      enter(only, straightIn);
      return;
    }

    // A membership that arrived unaccepted opens its modal immediately — a claim or invite 302 lands
    // here precisely so its consent can be taken, and making the person hunt for the row would be a
    // step the redirect exists to remove.
    const needsConsent = loaded.emails
      .flatMap((e) => e.memberships)
      .find((m) => m.scope === props.scope && modalFlavorFor(m));
    if (needsConsent) pending.value = needsConsent;
  } catch (e) {
    if ((e as Error).message === 'needs-login') {
      // The likeliest reason a bootstrap is refused is the one this screen exists for: a membership
      // that has not been taken up yet. Ask for its consent card before concluding anything.
      const card = await loadPendingCard().catch(() => undefined);
      if (card) { pending.value = card; loading.value = false; return; }
      error.value = 'This session needs to be signed in again.';
    } else {
      error.value = 'Could not load your accounts.';
    }
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="w-full max-w-2xl mx-auto space-y-4">
    <p v-if="loading" class="text-center text-base-content/70">Loading…</p>

    <div v-else-if="error" class="card bg-base-200">
      <div class="card-body items-center text-center">
        <p>{{ error }}</p>
        <a class="btn btn-primary btn-sm" href="/auth/login">Sign in</a>
      </div>
    </div>

    <template v-else>
      <!-- The email strip: every address on this identity, the signed-in one selected. -->
      <div v-if="sections.length > 1" class="tabs tabs-boxed">
        <button
          v-for="s in sections" :key="s.email"
          class="tab" :class="{ 'tab-active': s.email === activeSection?.email }"
          @click="selectedEmail = s.email"
        >
          {{ s.email }}
        </button>
      </div>

      <div v-if="activeSection" class="card bg-base-200">
        <div class="card-body">
          <p v-if="crossEmailNotice(activeSection)" class="alert alert-info text-sm">
            {{ crossEmailNotice(activeSection) }}
          </p>

          <p v-if="activeSection.memberships.length === 0" class="text-base-content/70">
            Nothing here yet.
          </p>

          <ul v-else class="space-y-1">
            <li v-for="m in activeSection.memberships" :key="m.scope">
              <button
                class="btn btn-ghost btn-block justify-start"
                :disabled="!modalFlavorFor(m) && !surfaceFor(m)"
                @click="openOrEnter(m)"
              >
                <span class="font-mono">{{ m.scope }}</span>
                <span v-if="modalFlavorFor(m)" class="badge badge-warning badge-sm">
                  {{ modalFlavorFor(m) === 'invite' ? 'Invitation' : 'Confirm' }}
                </span>
                <span v-else-if="m.childCount" class="badge badge-ghost badge-sm">
                  {{ m.childCount }}
                </span>
              </button>

              <!-- Descendants, only for a membership that has been taken up (the server withholds
                   them otherwise), and only expanded while the level is small enough to read. -->
              <ul v-if="m.children && rendersExpanded(m.children)" class="pl-6 space-y-1">
                <li v-for="c in m.children" :key="c.scope">
                  <button
                    class="btn btn-ghost btn-sm btn-block justify-start"
                    :disabled="!surfaceFor(c)"
                    @click="openOrEnter(c)"
                  >
                    <span class="font-mono">{{ c.scope }}</span>
                    <span v-if="c.childCount" class="badge badge-ghost badge-xs">{{ c.childCount }}</span>
                  </button>
                </li>
              </ul>
              <details v-else-if="m.children" class="pl-6">
                <summary class="cursor-pointer text-sm text-base-content/70">
                  {{ m.children.length }} inside
                </summary>
                <ul class="space-y-1 pt-1">
                  <li v-for="c in m.children" :key="c.scope">
                    <button
                      class="btn btn-ghost btn-sm btn-block justify-start"
                      :disabled="!surfaceFor(c)"
                      @click="openOrEnter(c)"
                    >
                      <span class="font-mono">{{ c.scope }}</span>
                    </button>
                  </li>
                </ul>
              </details>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <ConsentModal
      v-if="pending"
      :flavor="modalFlavorFor(pending)!"
      :scope="pending.scope"
      :invited-by-name="pending.invitedByName"
      :busy="accepting"
      @accept="accept"
      @decline="pending = undefined"
    />
  </div>
</template>
