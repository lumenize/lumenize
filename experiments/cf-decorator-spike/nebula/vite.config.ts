import { cloudflare } from '@cloudflare/vite-plugin';
import swc from 'unplugin-swc';

// The same plugins as the spike's, with unplugin-swc's default exclude: `@lumenize/*` resolves
// through workspace symlinks to real paths outside node_modules, as in apps/nebula-studio-ui. An
// `exclude: []` sends swc through node_modules too, where some packages' tsconfig.json extends a
// package nobody installed (`@ljharb/tsconfig`), and the build fails.
export default {
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
    cloudflare({ inspectorPort: false, persistState: false }),
  ],
};
