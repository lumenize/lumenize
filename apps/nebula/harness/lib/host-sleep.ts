/**
 * Notices when the machine running a scenario slept under it. A sleeping host fires no timers,
 * so a one-second tick that arrives a minute late means the process was not running in between.
 * A scenario's waits keep counting wall-clock across that gap, so a far-past-budget timeout there
 * belongs to the sleep and not to the code (2026-11-23: a deployed limb failed 1155 s in, with the
 * Mac asleep for fifteen minutes of it).
 */

/** One stretch the process did not run through, as ISO times and whole seconds. */
export interface HostSleepGap {
  from: string;
  to: string;
  seconds: number;
}

export interface HostSleepWatch {
  /** Every gap seen so far, including one the process is only now waking from. */
  gaps(): HostSleepGap[];
  stop(): void;
}

/** The line a failed run prints for each gap; the sweep looks for its first words. */
export const HOST_SLEPT_MARK = '💤 the host slept';

export function hostSleptLine(gap: HostSleepGap): string {
  return `${HOST_SLEPT_MARK} for ${gap.seconds}s under this run, from ${gap.from} to ${gap.to}: `
    + 'a timeout across that gap is the sleep, not the scenario';
}

/**
 * Starts the tick. `thresholdMs` is how late a tick must be to count as a gap: a busy event loop
 * delays a tick by seconds at most, so a minute leaves that well clear.
 */
export function watchForHostSleep(thresholdMs = 60_000, tickMs = 1_000): HostSleepWatch {
  const found: HostSleepGap[] = [];
  let last = Date.now();
  const check = (): void => {
    const now = Date.now();
    if (now - last >= thresholdMs) {
      found.push({
        from: new Date(last).toISOString(),
        to: new Date(now).toISOString(),
        seconds: Math.round((now - last) / 1000),
      });
    }
    last = now;
  };
  const timer = setInterval(check, tickMs);
  timer.unref();
  return {
    // A failure can be reported before the first tick after a wake has run, so check here too.
    gaps: () => { check(); return [...found]; },
    stop: () => clearInterval(timer),
  };
}
