<script setup lang="ts">
/**
 * The Universe page — where a freshly-signed-up account admin sees their apps and creates new ones.
 *
 * Reached at `/{universe}` (a one-segment scope; `App.vue`'s `isWorkspace` is false here), and
 * it is the FIRST authenticated surface a self-signup lands on: Home fast-forwards a lone-universe
 * identity straight here (`home-logic.ts` `fastForwardTarget` + `surfaceFor`). Before this existed a
 * self-signup dead-ended on Home with an unclickable account label — the create-your-first-app flow
 * lived only inside a galaxy, so it could make your *second* app but never your first.
 *
 * ⚠️ **Two flavours, and only one is built.** FLAVOUR A (built): create an app — a slug, a POST, and
 * you are in its Studio. FLAVOUR B (stub): list existing apps as clickable rows. A brand-new account
 * has no apps, so A is all a day-1 user meets; the list renders what few apps exist but is not yet
 * the richer manager it will become. The create modal opens itself when the list is empty, so the
 * empty state IS the create form.
 *
 * ⚠️ **Slug only — there is no app NAME to collect.** `createGalaxy(universe, slug)` takes a slug and
 * the schema stores no galaxy label, so the form asks for the one thing that exists. The server is
 * the final arbiter of the slug's shape (same as the signup screen); a rejected slug comes back as
 * `error` for the person to correct.
 */
import { ref, computed, watch } from 'vue';
import { Plus, Loader2, Rocket } from 'lucide-vue-next';

const props = defineProps<{
  /** The one-segment universe scope this page manages (e.g. `acme`). */
  universe: string;
  /** Galaxies directly under this universe — `{ scope: '{u}.{g}' }`. Empty for a fresh account. */
  apps: readonly { scope: string }[];
  /** True once the scope load has COMPLETED, so an empty `apps` means an empty ACCOUNT rather than
   *  a list that has not arrived yet. The auto-open below cannot tell those apart without it. */
  ready: boolean;
  /** True while a create is in flight — disables the form and shows a spinner. */
  busy: boolean;
  /** A server-side create failure to show the person (e.g. a taken or malformed slug). */
  error?: string;
}>();

const emit = defineEmits<{
  (e: 'create', slug: string): void;
  (e: 'open', scope: string): void;
}>();

const modalOpen = ref(false);
const slug = ref('');

/** The galaxy slug shown to the person — the part after `{universe}.`. */
function slugOf(scope: string): string {
  return scope.startsWith(`${props.universe}.`) ? scope.slice(props.universe.length + 1) : scope;
}

const canCreate = computed(() => slug.value.trim().length > 0 && !props.busy);

function openCreate() {
  slug.value = '';
  modalOpen.value = true;
}

function submit() {
  if (!canCreate.value) return;
  emit('create', slug.value.trim());
}

// A fresh account has no apps and nothing to choose — so the create form IS the page. An account
// that already has apps opens on the list, with Create one click away.
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
    if (props.apps.length === 0) openCreate();
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
        <button class="btn btn-primary btn-sm gap-2" :disabled="busy" @click="openCreate">
          <Plus class="size-4" /> Create app
        </button>
      </header>

      <!-- FLAVOUR B (stub): the app list. Empty for a fresh account. -->
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

    <!-- FLAVOUR A (built): create an app. -->
    <dialog class="modal" :open="modalOpen">
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
          <p v-if="error" class="text-sm text-error">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <button
              v-if="apps.length > 0"
              type="button"
              class="btn btn-ghost btn-sm"
              :disabled="busy"
              @click="modalOpen = false"
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
