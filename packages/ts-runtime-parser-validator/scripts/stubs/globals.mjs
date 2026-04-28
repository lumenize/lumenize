// Shim for Node.js globals that tsc expects at init time
// esbuild inject: these are prepended to the bundle

export const __filename = '/index.js';
export const __dirname = '/';

// Workers' `nodejs_compat_v2` provides a partial `process` polyfill that
// has `process` defined but is missing `argv` (and other fields). Vitest
// miniflare passes Node's real `process` through, hiding the asymmetry.
// `typescript` reads `process.argv.slice(2)` at module init — undefined.slice
// crashes the isolate before our code runs. Always use a defensive merge:
// real values where available, fallbacks for the rest.
const _real = typeof process !== 'undefined' ? process : undefined;
const _process = {
  env: _real?.env ?? { NODE_ENV: 'production' },
  argv: Array.isArray(_real?.argv) ? _real.argv : [],
  platform: _real?.platform ?? 'linux',
  versions: _real?.versions ?? { node: '20.0.0' },
  cwd: typeof _real?.cwd === 'function' ? _real.cwd.bind(_real) : () => '/',
  nextTick: typeof _real?.nextTick === 'function'
    ? _real.nextTick.bind(_real)
    : (fn, ...args) => queueMicrotask(() => fn(...args)),
  stderr: _real?.stderr ?? { write() {} },
  stdout: _real?.stdout ?? { write() {} },
};
export { _process as process };
