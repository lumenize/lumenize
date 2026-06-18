/**
 * @lumenize/mesh/container — the 4th Lumenize node type (LumenizeContainer).
 *
 * Separate entry point (NOT re-exported from `@lumenize/mesh`) so that core
 * `@lumenize/mesh` — which is MIT and imported by `auth`/`fetch`/`testing`/
 * `ts-runtime-parser-validator` — stays free of the `@cloudflare/containers`
 * dependency. Only consumers that need a container node import this subpath.
 * Precedent: the `./client` subpath. See tasks/nebula-devcontainer-node-type.md.
 */
export { LumenizeContainer, stripContainerTargetPort } from './lumenize-container';
