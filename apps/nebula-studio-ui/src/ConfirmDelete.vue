<script setup lang="ts">
/**
 * The confirmation a delete stands behind — component state, never the URL. A confirmation is what a
 * person is DOING, not what they are looking at, so it is not something to share a link to
 * (ADR-017).
 *
 * It reads the deletion plan before anything else and says who else loses access. That is a warning
 * and never a refusal: dominion runs downward, so the people beneath a scope cannot veto its
 * deletion by being there (ADR-015). The button stays enabled whatever the plan says. A refusal the
 * facade sends — a caller without dominion over the target — is shown by its own message.
 */
import { ref, onMounted } from 'vue';
import { Loader2 } from 'lucide-vue-next';

/** The plan's shape, as `client.scopes.deletePlan` answers it. */
interface Plan {
  affected: { instanceName: string }[];
  affectedUsers: { total: number; sample: { instanceName: string; email: string }[] };
}

const props = defineProps<{
  /** The scope to delete, e.g. `acme.crm`. */
  target: string;
  /** What the page calls it: "this app", "this account", or a tenant. */
  what: string;
  scopes: { deletePlan(target: string): Promise<Plan>; delete(target: string): Promise<unknown> };
}>();

const emit = defineEmits<{ deleted: []; cancel: [] }>();

const plan = ref<Plan | undefined>();
const busy = ref(false);
const error = ref('');

onMounted(async () => {
  try {
    plan.value = await props.scopes.deletePlan(props.target);
  } catch (e) {
    error.value = (e as Error).message || 'Could not check what this deletes.';
  }
});

async function go() {
  busy.value = true;
  error.value = '';
  try {
    await props.scopes.delete(props.target);
    emit('deleted');
  } catch (e) {
    error.value = (e as Error).message || 'Could not delete it.';
  } finally {
    busy.value = false;
  }
}

const others = (n: number) => `${n} other user${n === 1 ? '' : 's'} will lose access`;
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-modal="true" data-testid="confirm-delete">
    <div class="modal-box space-y-3">
      <h3 class="font-bold text-lg">Delete {{ what }}?</h3>
      <p class="text-sm font-mono">{{ target }}</p>
      <p v-if="!plan && !error" class="text-sm flex items-center gap-2">
        <Loader2 class="size-4 animate-spin" /> Checking who else is here…
      </p>
      <template v-else-if="plan">
        <p v-if="plan.affectedUsers.total === 0" class="text-sm">No other users — safe to delete.</p>
        <p v-else class="alert alert-warning text-sm">
          Warning — {{ others(plan.affectedUsers.total) }}:
          {{ plan.affectedUsers.sample.map((u) => u.email).join(', ') }}
        </p>
        <p class="text-sm opacity-70">
          This permanently deletes {{ plan.affected.length }} scope{{ plan.affected.length === 1 ? '' : 's' }} and
          everything in them.
        </p>
      </template>
      <p v-if="error" class="text-sm text-error" data-testid="confirm-delete-error">{{ error }}</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-error btn-sm gap-2" :disabled="busy" data-testid="confirm-delete-go" @click="go">
          <Loader2 v-if="busy" class="size-4 animate-spin" /> Delete permanently
        </button>
      </div>
    </div>
  </div>
</template>
