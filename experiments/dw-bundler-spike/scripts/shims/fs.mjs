// Shim for Node.js 'fs' module — tsc probes the filesystem at init
export function existsSync() { return false; }
export function readFileSync() { return ''; }
export function writeFileSync() {}
export function readdirSync() { return []; }
export function statSync() { return { isFile: () => false, isDirectory: () => false }; }
export function mkdirSync() {}
export function watchFile() {}
export function unwatchFile() {}
export const realpathSync = Object.assign(() => '/', { native: () => '/' });

export default {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync,
  mkdirSync, realpathSync, watchFile, unwatchFile,
};
