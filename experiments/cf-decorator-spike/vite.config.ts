import { cloudflare } from '@cloudflare/vite-plugin';
import swc from 'unplugin-swc';

// Rolldown passes TC39 decorators through untransformed and still exits 0, so swc transforms
// them first. `exclude: []` because @lumenize/mesh may resolve through node_modules here, where
// unplugin-swc's default exclude would skip it.
export default {
  plugins: [
    swc.vite({
      exclude: [],
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { decoratorVersion: '2022-03' },
        target: 'es2022',
      },
    }),
    cloudflare({ inspectorPort: false, persistState: false }),
  ],
};
