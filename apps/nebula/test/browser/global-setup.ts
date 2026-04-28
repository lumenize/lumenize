/**
 * Vitest globalSetup — auto-spawns `wrangler dev` against the baseline
 * test-app and exposes its URL to browser tests via `provide()`.
 *
 * Why this exists: browser tests need a real Worker isolate to talk to
 * (vitest-pool-workers' miniflare runs in-process, where Cloudflare's
 * `performance.now()` pinning ruins timing). Spawning real wrangler dev
 * gives us a real Worker; timing happens client-side in Chromium where
 * the wall clock advances normally.
 *
 * Reusable: the same pattern can move into Lumenize Mesh's tests when
 * that work picks up (noted in tasks/nebula-5.3-subscriptions.md).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestProject } from 'vitest/node';

const WRANGLER_CONFIG = './test/browser/worker/wrangler.jsonc';
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
  const port = await pickFreePort();

  wranglerProcess = spawn(
    'npx',
    [
      'wrangler@4.84.0', 'dev',
      '--config', WRANGLER_CONFIG,
      '--port', String(port),
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

  // Brief settle so Worker handlers are fully registered before tests start
  // hammering them.
  await delay(250);

  project.provide('wranglerBaseUrl', baseUrl);

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
