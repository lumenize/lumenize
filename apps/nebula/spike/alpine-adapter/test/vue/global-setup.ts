/**
 * Phase 1 globalSetup — spawns `wrangler dev` against the spike's
 * un-instrumented worker entry, provides the URL to browser tests.
 *
 * Mirrors `apps/nebula/test/browser/global-setup.ts` but with simpler config
 * (no email-test sidecar; test-mode magic links instead of real email).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { TestProject } from 'vitest/node';

const WRANGLER_CONFIG = './test/wrangler-dev.jsonc';
const READY_REGEX = /Ready on (https?:\/\/[^\s]+)/;
const READY_TIMEOUT_MS = 30_000;

let wranglerProcess: ChildProcess | null = null;

async function pickFreePort(): Promise<number> {
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

async function waitForReady(proc: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let resolved = false;
    const timer = globalThis.setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(
          `wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms.\n` +
          `stdout/stderr buffer:\n${buf.slice(-2000)}`,
        ));
      }
    }, READY_TIMEOUT_MS);
    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      buf += text;
      const match = buf.match(READY_REGEX);
      if (match && !resolved) {
        resolved = true;
        globalThis.clearTimeout(timer);
        resolve(match[1]);
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
}

export default async function setup(project: TestProject) {
  console.log('[spike global-setup] starting wrangler dev...');
  const port = await pickFreePort();
  console.log(`[spike global-setup] using port ${port}`);

  wranglerProcess = spawn(
    'wrangler',
    [
      'dev',
      '--config', WRANGLER_CONFIG,
      '--port', String(port),
      // HTTP on localhost works for browsers' Secure-cookie acceptance.
      // (HTTPS via wrangler dev's self-signed cert would need Playwright's
      // ignoreHTTPSErrors which isn't reliably plumbed through vitest-browser.)
      '--local-protocol', 'http',
      '--var', 'NEBULA_AUTH_TEST_MODE:true',
      '--var', 'NEBULA_AUTH_BOOTSTRAP_EMAIL:bootstrap-admin@example.com',
      '--var', 'PRIMARY_JWT_KEY:BLUE',
      '--var', 'NEBULA_AUTH_REDIRECT:/app',
      '--log-level', 'info',
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const baseUrl = await waitForReady(wranglerProcess);
  console.log(`[spike global-setup] wrangler ready at ${baseUrl}`);
  project.provide('wranglerBaseUrl', baseUrl);
  // Stash port via env var so the project's vite config can read it for
  // server.proxy setup. (globalSetup runs after Vite config is built, so
  // we can't directly mutate proxy config from here.)
  process.env.SPIKE_WRANGLER_PORT = String(port);

  return async () => {
    if (wranglerProcess && !wranglerProcess.killed) {
      wranglerProcess.kill('SIGINT');
      await new Promise<void>((resolve) => {
        if (!wranglerProcess) {
          resolve();
          return;
        }
        const killTimer = globalThis.setTimeout(() => {
          wranglerProcess?.kill('SIGKILL');
          resolve();
        }, 5_000);
        wranglerProcess.on('exit', () => {
          globalThis.clearTimeout(killTimer);
          resolve();
        });
      });
      wranglerProcess = null;
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    wranglerBaseUrl: string;
  }
}
