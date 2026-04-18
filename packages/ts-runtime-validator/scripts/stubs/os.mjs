export function platform() { return 'linux'; }
export function tmpdir() { return '/tmp'; }
export function homedir() { return '/home'; }
export function hostname() { return 'worker'; }
export function type() { return 'Linux'; }
export function release() { return '0.0.0'; }
export function arch() { return 'x64'; }
export function cpus() { return []; }
export function totalmem() { return 0; }
export function freemem() { return 0; }
export function networkInterfaces() { return {}; }
export function endianness() { return 'LE'; }
export function uptime() { return 0; }
export function loadavg() { return [0, 0, 0]; }
export const EOL = '\n';
export const devNull = '/dev/null';
export default { platform, tmpdir, homedir, hostname, type, release, arch, cpus, totalmem, freemem, networkInterfaces, endianness, uptime, loadavg, EOL, devNull };
