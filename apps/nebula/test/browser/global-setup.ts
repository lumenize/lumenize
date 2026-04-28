/**
 * Vitest globalSetup — auto-spawns `wrangler dev` against the browser
 * test-app and exposes its URL + the email-test TEST_TOKEN to browser
 * tests via `provide()`.
 *
 * Why this exists: browser tests need a real Worker isolate to talk to
 * (vitest-pool-workers' miniflare runs in-process, where Cloudflare's
 * `performance.now()` pinning ruins timing). Spawning real wrangler dev
 * gives us a real Worker; timing happens client-side in Chromium where
 * the wall clock advances normally.
 *
 * Why HTTPS: NebulaAuth sets cookies with `Secure`, which browsers refuse
 * over plain http on a non-localhost-treated origin. `--local-protocol https`
 * makes wrangler generate a self-signed cert; Playwright is configured with
 * `ignoreHTTPSErrors` to accept it. This keeps the cookie path identical
 * to production — no test-mode bypasses.
 *
 * Why no NEBULA_AUTH_TEST_MODE: tests exercise the real magic-link email
 * flow via Cloudflare Email Sending → Email Routing → deployed
 * email-test Worker → WebSocket back to the test. Test mode in any
 * wrangler invocation is a leak risk.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
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

/**
 * Read the email-test deployment's TEST_TOKEN from the root .dev.vars so the
 * browser tests can authenticate to its WebSocket. The wrangler-dev process
 * has its own .dev.vars symlink for the Worker's secrets; this reads the
 * same file from globalSetup's Node context.
 */
function readTestToken(): string {
  const path = resolvePath(process.cwd(), '.dev.vars');
  const contents = readFileSync(path, 'utf8');
  const match = contents.match(/^TEST_TOKEN=(.*)$/m);
  if (!match) {
    throw new Error(`TEST_TOKEN not found in ${path}. Required for the browser harness's e2e email flow.`);
  }
  return match[1].trim();
}

export default async function setup(project: TestProject) {
  const port = await pickFreePort();
  const testToken = readTestToken();

  wranglerProcess = spawn(
    'wrangler',
    [
      'dev',
      '--config', WRANGLER_CONFIG,
      '--port', String(port),
      '--local-protocol', 'https',
      '--var', 'NEBULA_AUTH_BOOTSTRAP_EMAIL:test@lumenize.io',
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

  project.provide('wranglerBaseUrl', baseUrl);
  project.provide('emailTestToken', testToken);

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
    emailTestToken: string;
  }
}
