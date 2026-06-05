// Shim for Node.js 'perf_hooks' — use globalThis.performance
export const performance = globalThis.performance || { now: () => Date.now() };
export default { performance };
