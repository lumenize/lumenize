<script setup lang="ts">
/**
 * The Universe page — an account's own page, at its host (`acme.lumenize.dev` is the account
 * `acme`, ADR-021): its apps, the form that creates one, and the account's delete.
 *
 * Every action on an account lives here, and Home only links to it: Home's "+ App" opens this page at
 * `?create`, and its Delete opens this page. An app is deleted from its own Studio instead, so an
 * app's admin who holds nothing at the account can still delete it.
 *
 * The create form is open exactly when the URL says `?create` (ADR-017). An account holding no apps
 * has nothing to choose between, so the page navigates there itself — a claim writes the account's
 * first app, so that is an account whose apps were all deleted. "Delete this account" stands behind a
 * confirmation that is component state and never the URL, since a confirmation is something a person
 * is doing rather than looking at.
 *
 * ⚠️ **Slug only — there is no app NAME to collect.** `createGalaxy(universe, slug)` takes a slug and
 * the schema stores no galaxy label, so the form asks for the one thing that exists. The server is
 * the final arbiter of the slug's shape (same as the signup screen); a rejected slug comes back as
 * `error` for the person to correct.
 */
import { ref, computed, watch } from 'vue';
import { Plus, Loader2, Rocket, Trash2 } from 'lucide-vue-next';
import DataUseNotice from './DataUseNotice.vue';

const props = defineProps<{
  /** The one-segment universe scope this page manages (e.g. `acme`). */
  universe: string;
  /** Galaxies directly under this universe — `{ scope: '{u}.{g}' }`. Empty for a fresh account. */
  apps: readonly { scope: string }[];
  /** True once the scope load has COMPLETED, so an empty `apps` means an empty ACCOUNT rather than
   *  a list that has not arrived yet. The auto-open below cannot tell those apart without it. */
  ready: boolean;
  /** The create form is open — decided by the URL (`?create`), never here (ADR-017). */
  create: boolean;
  /** True while a create is in flight — disables the form and shows a spinner. */
  busy: boolean;
  /** A server-side create failure to show the person (e.g. a taken or malformed slug). */
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'create', slug: string): void;
  /** Ask the shell to open the form by navigation; `auto` = the empty-account case, which rewrites
   *  the URL in place rather than pushing an entry Back would only reopen. */
  (e: 'create-open', auto: boolean): void;
  (e: 'create-close'): void;
  (e: 'open', scope: string): void;
  /** Ask the shell to confirm and delete this account. */
  (e: 'delete-account'): void;
}>();

const slug = ref('');

/** The galaxy slug shown to the person — the part after `{universe}.`. */
function slugOf(scope: string): string {
  return scope.startsWith(`${props.universe}.`) ? scope.slice(props.universe.length + 1) : scope;
}

const canCreate = computed(() => slug.value.trim().length > 0 && !props.busy);

function openCreate(auto = false) {
  slug.value = '';
  emit('create-open', auto);
}

function submit() {
  if (!canCreate.value) return;
  emit('create', slug.value.trim());
}

// An account with no apps has nothing to choose, so the create form opens on its own. A claim writes
// the account's first app, so this is an account whose apps were all deleted, and its owner may want
// the account gone too: Cancel always shows, and closing the form leaves "Delete this account" in
// reach. An account that has apps opens on the list, with Create one click away.
//
// ⚠️ **Gated on `ready`, and fires at most once.** On mount the list is always empty — the scope
// load has not resolved yet — so an `onMounted` version popped the create form open on EVERY visit,
// including a returning account's, which is the opposite of the list flavour it is supposed to show.
let autoOpened = false;
watch(
  () => [props.ready, props.apps.length] as const,
  () => {
    if (autoOpened || !props.ready) return;
    autoOpened = true;
    if (props.apps.length === 0) openCreate(true);
  },
  { immediate: true },
);
</script>

<template>
  <div class="w-full h-full overflow-y-auto">
    <div class="max-w-2xl mx-auto p-8 flex flex-col gap-6">
      <header class="flex items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-bold">{{ universe }}</h1>
          <p class="text-sm opacity-70">Your account. Everything you build lives here.</p>
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-ghost btn-sm gap-2" :disabled="busy" data-testid="universe-delete" @click="emit('delete-account')">
            <Trash2 class="size-4" /> Delete this account
          </button>
          <button class="btn btn-primary btn-sm gap-2" :disabled="busy" @click="openCreate()">
            <Plus class="size-4" /> Create app
          </button>
        </div>
      </header>

      <!-- The account's apps, each opening its Studio. -->
      <div class="card bg-base-200">
        <div class="card-body">
          <p v-if="apps.length === 0" class="text-base-content/70">
            No apps yet. Create your first one to start building.
          </p>
          <ul v-else class="space-y-1">
            <li v-for="a in apps" :key="a.scope">
              <button
                class="btn btn-ghost btn-block justify-start gap-2"
                :disabled="busy"
                @click="emit('open', a.scope)"
              >
                <Rocket class="size-4 opacity-70" />
                <span class="font-mono">{{ slugOf(a.scope) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Create an app. -->
    <dialog class="modal" :open="props.create">
      <div class="modal-box">
        <h3 class="text-lg font-bold">Create an app</h3>
        <p class="py-2 text-sm opacity-80">Pick a short name. You can build as many apps as you like.</p>
        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <input
            v-model="slug"
            type="text"
            autofocus
            class="input w-full"
            placeholder="crm"
            :disabled="busy"
          />
          <p class="text-xs opacity-60">Lowercase letters, numbers and hyphens.</p>
          <DataUseNotice />
          <p v-if="error" class="text-sm text-error">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              data-testid="create-cancel"
              :disabled="busy"
              @click="emit('create-close')"
            >
              Cancel
            </button>
            <button type="submit" class="btn btn-primary btn-sm gap-2" :disabled="!canCreate">
              <Loader2 v-if="busy" class="size-4 animate-spin" /> Create
            </button>
          </div>
        </form>
      </div>
    </dialog>
  </div>
</template>
