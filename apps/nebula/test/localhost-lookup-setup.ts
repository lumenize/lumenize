/**
 * The `*.lumenize.localhost` lookup again, inside a test worker (`harness/lib/localhost-lookup.ts`).
 * `vitest.config.js` installs it in vitest's own process, which runs global setup, the vite proxy
 * and the browser-mode server; test files run in worker processes that never load the config, so a
 * Node project whose tests dial those hosts installs it here too. On macOS, and on a Linux whose
 * resolver answers `*.localhost`, it changes nothing.
 */
import { installLocalhostLookup } from '../harness/lib/localhost-lookup';

installLocalhostLookup();
