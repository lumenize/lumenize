// Shim for Node.js 'path' module
export const sep = '/';
export const delimiter = ':';
export function dirname(p) { return p.replace(/\/[^/]*$/, '') || '/'; }
export function basename(p) { return p.replace(/.*\//, ''); }
export function extname(p) { const m = p.match(/\.[^.]+$/); return m ? m[0] : ''; }
export function join(...args) { return args.join('/'); }
export function resolve(...args) { return args.join('/'); }
export function normalize(p) { return p; }
export function isAbsolute(p) { return p.startsWith('/'); }
export function relative(a, b) { return b; }

const posix = { sep, delimiter, dirname, basename, extname, join, resolve, normalize, isAbsolute, relative };
export { posix };
export const win32 = posix;

export default { sep, delimiter, dirname, basename, extname, join, resolve, normalize, isAbsolute, relative, posix, win32 };
