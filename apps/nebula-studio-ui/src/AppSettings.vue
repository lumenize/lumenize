<script setup lang="ts">
/**
 * An app's settings, opened at `?app` from Studio's account menu: the app's tenants, each with a
 * delete, and a delete for the app itself.
 *
 * A tenant is a Star beneath the app's galaxy, listed through `client.scopes.expand()`, whose parent
 * is this page's own scope. The `.dev` Star is the app's workspace rather than a tenant, so it is
 * not offered. Each delete opens {@link ConfirmDelete}, which says who else loses access and never
 * rides the URL; the facade decides, refusing a caller without dominion over the target.
 *
 * Every action here lives on the app's own host, so a galaxy's admin can delete their app without
 * holding anything at the account above it.
 */
import { ref, onMounted } from 'vue';
import { Trash2 } from 'lucide-vue-next';
import ConfirmDelete from './ConfirmDelete.vue';

type Plan = { affected: { instanceName: string }[]; affectedUsers: { total: number; sample: { instanceName: string; email: string }[] } };

const props = defineProps<{
  /** This page's galaxy, e.g. `acme.crm`. */
  galaxy: string;
  scopes: {
    expand(after?: string): Promise<{ children: { scope: string; tier: string }[]; nextCursor?: string }>;
    deletePlan(target: string): Promise<Plan>;
    delete(target: string): Promise<unknown>;
  };
}>();

const emit = defineEmits<{ close: []; 'app-deleted': [] }>();

const tenants = ref<string[]>([]);
const loaded = ref(false);
const error = ref('');
const confirming = ref<{ target: string; what: string } | undefined>();

async function load() {
  error.value = '';
  try {
    const found: string[] = [];
    let after: string | undefined;
    do {
      const page = await props.scopes.expand(after);
      found.push(...page.children.filter((c) => c.tier === 'star' && !c.scope.endsWith('.dev')).map((c) => c.scope));
      after = page.nextCursor;
    } while (after);
    tenants.value = found;
  } catch (e) {
    error.value = (e as Error).message || 'Could not load the tenants.';
  } finally {
    loaded.value = true;
  }
}

/** The part of a tenant's scope after `{galaxy}.`. */
const slugOf = (scope: string) => scope.slice(props.galaxy.length + 1);

function onDeleted() {
  const deleted = confirming.value?.target;
  confirming.value = undefined;
  if (deleted === props.galaxy) emit('app-deleted');
  else void load();
}

onMounted(load);
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-modal="true" data-testid="app-settings">
    <div class="modal-box space-y-4">
      <h3 class="font-bold text-lg">App settings</h3>

      <section class="space-y-2">
        <h4 class="font-semibold">Tenants</h4>
        <p v-if="!loaded" class="text-sm opacity-70">Loading…</p>
        <p v-else-if="error" class="text-sm text-error">{{ error }}</p>
        <p v-else-if="tenants.length === 0" class="text-sm opacity-70">No tenants yet.</p>
        <ul v-else class="space-y-1">
          <li v-for="t in tenants" :key="t" class="flex items-center gap-2" data-testid="app-tenant" :data-scope="t">
            <span class="font-mono text-sm flex-1">{{ slugOf(t) }}</span>
            <button
              class="btn btn-ghost btn-sm btn-square"
              title="Delete this tenant"
              data-testid="app-tenant-delete"
              @click="confirming = { target: t, what: `the tenant ${slugOf(t)}` }"
            >
              <Trash2 class="size-4" />
            </button>
          </li>
        </ul>
      </section>

      <section class="space-y-2 border-t border-base-300 pt-4">
        <button class="btn btn-error btn-sm" data-testid="app-delete" @click="confirming = { target: galaxy, what: 'this app' }">
          Delete this app
        </button>
      </section>

      <div class="modal-action">
        <button class="btn btn-sm" @click="emit('close')">Close</button>
      </div>
    </div>
    <ConfirmDelete
      v-if="confirming"
      :target="confirming.target"
      :what="confirming.what"
      :scopes="scopes"
      @deleted="onDeleted"
      @cancel="confirming = undefined"
    />
  </div>
</template>
