/**
 * The shared app's key and record (`shared-app.ts`), apart from the harness, so the Node lane tests
 * them without the Worker graph a driver pulls in.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** A run's shared account and app, and the address that owns them. */
export interface SharedApp {
  /** The account, `test-1003-runab12cd`. */
  universe: string;
  /** Its first app, `test-1003-runab12cd.test-1003-appef34gh`. */
  galaxy: string;
  /** The owner's address, which signs in by email. */
  ownerEmail: string;
}

/** This run's id: `drive.ts` sets one for a sweep's every scenario, and a lone process makes its own. */
const RUN_ID = process.env.HARNESS_RUN_ID ?? crypto.randomUUID();

/** The share's key: the stack and the run, never the origin alone, which a later local boot can reuse. */
export function sharedAppKey(stackId: string, runId: string = RUN_ID): string {
  return createHash('sha256').update(`${stackId}|${runId}`).digest('hex').slice(0, 24);
}

/** Where the run's record lives: the OS's temp directory, since it holds names and an address only. */
export function sharedAppFile(stackId: string, runId: string = RUN_ID): string {
  return join(tmpdir(), 'lumenize-shared-app', `${sharedAppKey(stackId, runId)}.json`);
}

/** The run's record on `stackId`, or `undefined` before any scenario has asked for it. */
export function readSharedApp(stackId: string, runId: string = RUN_ID): SharedApp | undefined {
  const file = sharedAppFile(stackId, runId);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as SharedApp : undefined;
}

/** The record at `file`, or the one `create` makes, written there for the run's later scenarios. */
export async function cachedApp(file: string, create: () => Promise<SharedApp>): Promise<SharedApp> {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as SharedApp;
  const app = await create();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(app));
  return app;
}
