import { ref, reactive } from 'vue';

/** The store each component reads — set by the test before mounting, as `./nebula` exports it in an app. */
export const holder: { store: any } = { store: null };
/** Which resource id the switch/computed components read; changing it is a re-render that reads a NEW id. */
export const current = ref('');
/** The ids the list components render; pushing one is a re-render that reads a NEW id. */
export const ids = reactive<string[]>([]);
/** An unrelated dep, to force re-renders that read the SAME id. */
export const tick = ref(0);
/** What the reading code saw: is an effect scope active, is there a component instance. */
export const probes: Array<{ where: string; scope: boolean; instance: boolean }> = [];
