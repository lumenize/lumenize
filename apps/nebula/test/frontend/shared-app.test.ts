/**
 * The `/live` harness's shared app and host wait (`harness/lib/shared-app-record.ts`,
 * `harness/lib/wait-for-host.ts`).
 *
 * In the Node lane, since what they decide is a key, a file and a retry: a local sweep boots a stack
 * per scenario, so no running system can show two scenarios sharing an app before a deployed run,
 * and a local host answers the first probe.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedApp, sharedAppKey, type SharedApp } from '../../harness/lib/shared-app-record';
import { waitForHost } from '../../harness/lib/wait-for-host';

describe('the shared app', () => {
  it('is one app per stack and run, and a new stack never inherits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-app-'));
    let made = 0;
    const create = async (): Promise<SharedApp> => {
      made++;
      return { universe: `u${made}`, galaxy: `u${made}.g`, ownerEmail: `owner${made}@example.com` };
    };
    const fileFor = (stackId: string, runId = 'run-1') => join(dir, `${sharedAppKey(stackId, runId)}.json`);
    const first = await cachedApp(fileFor('deployed'), create);
    expect(await cachedApp(fileFor('deployed'), create)).toEqual(first);
    // A later local boot, with empty storage of its own, makes its own.
    const otherBoot = await cachedApp(fileFor('boot-2'), create);
    expect(otherBoot.universe).not.toBe(first.universe);
    // So does the next run on the same stack.
    expect((await cachedApp(fileFor('deployed', 'run-2'), create)).universe).not.toBe(first.universe);
    expect(made).toBe(3);
  });
});

describe('waitForHost', () => {
  it('keeps probing while the host fails, and returns once it answers', async () => {
    let probes = 0;
    await waitForHost('https://crm.acme.lumenize-test.dev/gateway', {
      intervalMs: 1, probe: async () => { if (++probes < 3) throw new TypeError('fetch failed'); },
    });
    expect(probes).toBe(3);
  });

  it('gives up past its timeout, naming the host', async () => {
    await expect(waitForHost('https://crm.acme.lumenize-test.dev/', {
      intervalMs: 1, timeoutMs: 20, probe: async () => { throw new TypeError('fetch failed'); },
    })).rejects.toThrow(/https:\/\/crm\.acme\.lumenize-test\.dev never answered/);
  });
});
