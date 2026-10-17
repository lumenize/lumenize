/**
 * The wait before entering a new app (`apps/nebula-studio-ui/src/host-wait.ts`): poll the
 * destination's origin until it answers, and say so only once it has missed.
 *
 * In-lane, since no running system reaches a wait before a deployment: the local stack's `http`
 * hosts answer the first probe, so `/live` sees the wait end at once. Whether a real `no-cors` probe
 * rejects through a failing TLS handshake is the deployed pass's to show, with a real certificate.
 */
import { describe, it, expect } from 'vitest';
import { waitUntilHostAnswers } from '../../../nebula-studio-ui/src/host-wait';

/** A probe that misses `misses` times and then answers, recording what it was asked. */
function scripted(misses: number) {
  const asked: string[] = [];
  return {
    asked,
    probe: async (origin: string) => {
      asked.push(origin);
      if (asked.length <= misses) throw new TypeError('Failed to fetch');
    },
  };
}

describe('waitUntilHostAnswers', () => {
  it('enters a host that answers at once, showing no wait', async () => {
    const { asked, probe } = scripted(0);
    let waits = 0;
    await waitUntilHostAnswers('http://crm.acme.lumenize.localhost:8787/', { probe, intervalMs: 1, onWaiting: () => { waits++; } });
    expect(asked).toHaveLength(1);
    expect(waits).toBe(0);
  });

  it('keeps probing while the host misses, and says so once', async () => {
    const { asked, probe } = scripted(3);
    let waits = 0;
    await waitUntilHostAnswers('https://crm.acme.lumenize.dev/', { probe, intervalMs: 1, onWaiting: () => { waits++; } });
    expect(asked).toHaveLength(4);
    expect(waits).toBe(1);
  });

  it("probes the destination's origin, not the page it is going to", async () => {
    const { asked, probe } = scripted(0);
    await waitUntilHostAnswers('https://crm.acme.lumenize.dev/?create', { probe, intervalMs: 1 });
    expect(asked).toEqual(['https://crm.acme.lumenize.dev']);
  });

  it("enters a relative URL at once, since it is on the page's own host", async () => {
    const { asked, probe } = scripted(Infinity);
    await waitUntilHostAnswers('/auth/signup', { probe, intervalMs: 1 });
    expect(asked).toEqual([]);
  });

  it('stops probing once the page has gone elsewhere', async () => {
    const { asked, probe } = scripted(Infinity);
    const gone = new AbortController();
    const waiting = waitUntilHostAnswers('https://crm.acme.lumenize.dev/', {
      probe, intervalMs: 5, signal: gone.signal, onWaiting: () => gone.abort(),
    });
    await waiting;
    expect(asked).toHaveLength(1);
  });
});
