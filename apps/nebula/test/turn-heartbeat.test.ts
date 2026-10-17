/**
 * `withHeartbeat` — pure, so this is the tier for it: every property below is about a clock and a
 * promise, nothing about a running system. The running-system half (a keepalive reaches a real
 * client over the real wire) is `baseline/child3-stream.test.ts`'s territory.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withHeartbeat } from '../src/turn-heartbeat';

const INTERVAL = 1_000;

describe('withHeartbeat', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('beats on the interval while the work is pending, then stops and returns the result', async () => {
    const beat = vi.fn();
    let finish!: (v: string) => void;
    const p = withHeartbeat(() => new Promise<string>((r) => { finish = r; }), beat,
      { intervalMs: INTERVAL, deadlineAt: 60_000 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3 + 1);
    expect(beat).toHaveBeenCalledTimes(3);
    finish('done');
    expect(await p).toBe('done');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(beat).toHaveBeenCalledTimes(3); // cleared on settle — no beat outlives the work
  });

  it('never beats when the work settles before the first tick', async () => {
    const beat = vi.fn();
    expect(await withHeartbeat(async () => 42, beat, { intervalMs: INTERVAL, deadlineAt: 60_000 })).toBe(42);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(beat).not.toHaveBeenCalled();
  });

  it('stops beating at the deadline while the work is still pending — the hang stays detectable', async () => {
    const beat = vi.fn();
    const never = new Promise<void>(() => {});
    void withHeartbeat(() => never, beat, { intervalMs: INTERVAL, deadlineAt: INTERVAL * 2 + 500 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 10);
    // Ticks at 1s and 2s beat; the tick at 3s is past the deadline and stops the timer for good.
    expect(beat).toHaveBeenCalledTimes(2);
  });

  it('does not start at all when the deadline has already passed', async () => {
    const beat = vi.fn();
    const never = new Promise<void>(() => {});
    void withHeartbeat(() => never, beat, { intervalMs: INTERVAL, deadlineAt: -1 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(beat).not.toHaveBeenCalled();
  });

  it('propagates a rejection and still clears the timer', async () => {
    const beat = vi.fn();
    let fail!: (e: Error) => void;
    const p = withHeartbeat(() => new Promise<void>((_, rej) => { fail = rej; }), beat,
      { intervalMs: INTERVAL, deadlineAt: 60_000 });
    await vi.advanceTimersByTimeAsync(INTERVAL + 1);
    fail(new Error('model exploded'));
    await expect(p).rejects.toThrow('model exploded');
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(beat).toHaveBeenCalledTimes(1);
  });

  it('a throwing beat never breaks the work', async () => {
    const beat = vi.fn(() => { throw new Error('socket gone'); });
    let finish!: (v: number) => void;
    const p = withHeartbeat(() => new Promise<number>((r) => { finish = r; }), beat,
      { intervalMs: INTERVAL, deadlineAt: 60_000 });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2 + 1);
    finish(7);
    expect(await p).toBe(7);
    expect(beat).toHaveBeenCalledTimes(2);
  });
});
