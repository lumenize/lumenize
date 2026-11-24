import { bindings, defineConfig, exports as configExports } from 'cf/config';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

const name = 'experiment-cf-decorator-spike';

export default defineConfig({
  worker: {
    name,
    entrypoint,
    compatibilityDate: '2026-10-01',
    exports: {
      Caller: configExports.durableObject({ storage: 'sqlite' }),
      Callee: configExports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      CALLER: bindings.durableObject({ worker: name, exportName: 'Caller' }),
      CALLEE: bindings.durableObject({ worker: name, exportName: 'Callee' }),
    },
    observability: { enabled: true },
  },
});
