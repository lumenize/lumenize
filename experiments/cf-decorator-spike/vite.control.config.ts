import { cloudflare } from '@cloudflare/vite-plugin';

// CONTROL: the same build with no swc, to show the decorator check can fail.
export default { plugins: [cloudflare({ inspectorPort: false, persistState: false })] };
