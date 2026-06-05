// Shim for Node.js 'os' module — tsc calls os.platform() at init time
export function platform() { return 'linux'; }
export function arch() { return 'x64'; }
export function type() { return 'Linux'; }
export function release() { return '0.0.0'; }
export function tmpdir() { return '/tmp'; }
export function homedir() { return '/'; }
export function cpus() { return [{}]; }
export function networkInterfaces() { return {}; }
export const EOL = '\n';

export default {
  platform, arch, type, release, tmpdir, homedir, cpus, networkInterfaces, EOL,
};
