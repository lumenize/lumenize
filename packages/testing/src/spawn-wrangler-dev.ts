/**
 * Node-only helper for vitest `globalSetup` files that need a real
 * `wrangler dev` process (e.g. real-browser test tiers — see
 * `packages/mesh/test/browser/README.md`).
 *
 * This file uses `node:child_process` and `node:net` and is exported
 * exclusively under the `@lumenize/testing/wrangler` subpath. Don't import
 * it from code that ever runs in workerd or a browser bundle — the main
 * `@lumenize/testing` barrel is workerd-safe and stays that way by
 * excluding this file.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * Pick a free TCP port by opening a listener on `0`, reading the OS-assigned
 * port, then closing. Standard pattern for "I need a port and I don't care
 * which one."
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== 'object' || !addr) {
        reject(new Error('Could not get free port'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Configuration for {@link spawnWranglerDev}.
 */
export interface SpawnWranglerDevOptions {
  /**
   * Path to the wrangler config file, relative to `cwd`.
   * E.g. `'./test/browser/worker/wrangler.jsonc'`.
   */
  configPath: string;

  /**
   * Extra command-line args to append after the auto-generated `dev`,
   * `--config`, `--port`, and `--ip` args. Use this for `--local-protocol https`,
   * `--var`, `--log-level`, etc.
   *
   * Default: `[]`.
   */
  extraArgs?: string[];

  /**
   * Working directory for the wrangler process. Default: `process.cwd()`.
   */
  cwd?: string;

  /**
   * How long to wait for wrangler to log its "Ready on <url>" line before
   * giving up.
   *
   * Default: `30000` (30 seconds).
   */
  readyTimeoutMs?: number;

  /**
   * Hook for piping wrangler's stdout/stderr to the caller's preferred sink
   * (e.g. `process.stderr.write` for live diagnostics during a hang).
   *
   * Default: discard (the spawner consumes the streams internally to detect
   * "Ready on", but doesn't forward them).
   */
  onStdio?: (chunk: string) => void;
}

/**
 * Result returned by {@link spawnWranglerDev}.
 */
export interface SpawnedWranglerDev {
  /**
   * The base URL wrangler is listening on, as announced in its
   * "Ready on <url>" log line (e.g. `'http://127.0.0.1:51234'`).
   */
  baseUrl: string;

  /**
   * Terminate the wrangler process. Sends SIGINT first; if it doesn't exit
   * within 5 seconds, sends SIGKILL. Safe to call multiple times.
   */
  cleanup: () => Promise<void>;
}

/**
 * Spawn `wrangler dev` against the given config and resolve once it's ready
 * to serve. Returns `{ baseUrl, cleanup }` — the caller is responsible for
 * exposing `baseUrl` via vitest's `project.provide(...)` (or however else)
 * and invoking `cleanup` from the teardown phase.
 *
 * Forces `--ip 127.0.0.1` to dodge IPv6/IPv4 localhost resolution mismatches
 * (`localhost` may resolve to `::1` on macOS while wrangler binds only
 * 127.0.0.1, producing a confusing "ECONNREFUSED" or generic browser-side
 * "Failed to fetch").
 *
 * @example
 * ```ts
 * // In test/browser/global-setup.ts
 * import { spawnWranglerDev } from '@lumenize/testing/wrangler';
 *
 * let teardown: (() => Promise<void>) | null = null;
 *
 * export default async function setup(project) {
 *   const { baseUrl, cleanup } = await spawnWranglerDev({
 *     configPath: './test/browser/worker/wrangler.jsonc',
 *   });
 *   teardown = cleanup;
 *   project.provide('wranglerBaseUrl', baseUrl);
 *   return async () => { await teardown?.(); };
 * }
 * ```
 */
export async function spawnWranglerDev(
  options: SpawnWranglerDevOptions,
): Promise<SpawnedWranglerDev> {
  const {
    configPath,
    extraArgs = [],
    cwd = process.cwd(),
    readyTimeoutMs = 30_000,
    onStdio,
  } = options;

  const port = await pickFreePort();

  const proc = spawn(
    'wrangler',
    ['dev', '--config', configPath, '--port', String(port), '--ip', '127.0.0.1', ...extraArgs],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const readyRegex = /Ready on (https?:\/\/[^\s]+)/;

  const baseUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    let resolved = false;

    const timer = globalThis.setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(
          `wrangler dev did not become ready within ${readyTimeoutMs}ms.\n` +
          `stdout/stderr buffer:\n${buf.slice(-2000)}`,
        ));
      }
    }, readyTimeoutMs);

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      buf += text;
      onStdio?.(text);
      const match = buf.match(readyRegex);
      if (match && !resolved) {
        resolved = true;
        globalThis.clearTimeout(timer);
        resolve(match[1]!);
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        globalThis.clearTimeout(timer);
        reject(new Error(`wrangler dev exited (code=${code}) before becoming ready.\n${buf}`));
      }
    });
  });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp || proc.killed) {
      cleanedUp = true;
      return;
    }
    cleanedUp = true;
    proc.kill('SIGINT');
    await new Promise<void>((resolve) => {
      const killTimer = globalThis.setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5_000);
      proc.on('exit', () => {
        globalThis.clearTimeout(killTimer);
        resolve();
      });
    });
  };

  return { baseUrl, cleanup };
}
