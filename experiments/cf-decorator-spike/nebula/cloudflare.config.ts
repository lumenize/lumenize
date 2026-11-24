import { defineConfig, exports as configExports } from 'cf/config';
import * as entrypoint from '../../../apps/nebula/src/worker.ts' with { type: 'cf-worker' };

// BUILD-ONLY: the real Nebula Worker entry under cf's Vite build, to see whether the whole graph
// transforms and parses. Bindings, vars, routes, assets and containers are left out, since a build
// reads none of them; this is not a deployable config.
const sqlite = () => configExports.durableObject({ storage: 'sqlite' });

export default defineConfig({
  worker: {
    name: 'experiment-cf-decorator-spike-nebula',
    entrypoint,
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    exports: { Universe: sqlite(), Galaxy: sqlite(), Star: sqlite(), AuthRegistry: sqlite(), Profile: sqlite() },
  },
});
