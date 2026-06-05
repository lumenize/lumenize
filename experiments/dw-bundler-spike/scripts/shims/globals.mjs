// Shim for Node.js globals that tsc expects at init time
// esbuild inject: these are prepended to the bundle

export const __filename = '/index.js';
export const __dirname = '/';

// Provide a minimal process object if not available
const _process = typeof process !== 'undefined' ? process : {
  env: { NODE_ENV: 'production' },
  argv: [],
  platform: 'linux',
  versions: { node: '20.0.0' },
  cwd: () => '/',
  nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)),
  stderr: { write() {} },
  stdout: { write() {} },
};
export { _process as process };
