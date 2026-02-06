/**
 * Tab ID management with BroadcastChannel duplicate-tab detection.
 *
 * Each browser tab gets a unique tab ID stored in sessionStorage.
 * When a tab is duplicated, sessionStorage is cloned — both tabs would
 * share the same tabId. BroadcastChannel detects this conflict:
 * the original tab listens on its tabId channel, and the duplicate
 * probes to see if anyone else is already using it.
 *
 * Dependencies (sessionStorage, BroadcastChannel) are injected so
 * tests can pass Context properties directly without mocking globals.
 */

/** Timeout for the duplicate-tab probe (ms) */
const PROBE_TIMEOUT_MS = 50;

/** sessionStorage key for the tab ID */
const TAB_ID_KEY = 'lmz_tab';

/**
 * Dependencies for tab ID management.
 *
 * In browsers, pass `window.sessionStorage` and `window.BroadcastChannel`.
 * In tests, pass `context.sessionStorage` and `context.BroadcastChannel`
 * from `@lumenize/testing`'s `Browser.context()`.
 */
export interface TabIdDeps {
  sessionStorage: Storage;
  BroadcastChannel: typeof BroadcastChannel;
}

/**
 * Get or create a unique tab ID for this browsing context.
 *
 * - If sessionStorage already has a tab ID, probes via BroadcastChannel
 *   to check if another tab is using it (duplicate-tab detection).
 * - If the tab ID is in use, generates a new one.
 * - Sets up a permanent listener so future duplicates can detect us.
 *
 * @param deps - Injected sessionStorage and BroadcastChannel
 * @returns The tab ID string (8-char UUID prefix)
 */
export async function getOrCreateTabId(deps: TabIdDeps): Promise<string> {
  const stored = deps.sessionStorage.getItem(TAB_ID_KEY);

  if (stored) {
    // Check if another tab is already using this tabId
    const isInUse = await checkTabIdInUse(stored, deps);
    if (!isInUse) {
      // No other tab responded — safe to reuse
      setupTabIdListener(stored, deps);
      return stored;
    }
    // Another tab has this tabId — we're a duplicate, fall through to regenerate
  }

  const tabId = crypto.randomUUID().slice(0, 8);
  deps.sessionStorage.setItem(TAB_ID_KEY, tabId);
  setupTabIdListener(tabId, deps);
  return tabId;
}

/**
 * Set up a permanent listener that responds to probes from duplicate tabs.
 *
 * When another tab with the same cloned tabId sends a 'probe' message,
 * we respond with 'in-use' so it knows to regenerate.
 *
 * The channel stays open for the lifetime of the tab.
 */
function setupTabIdListener(tabId: string, deps: TabIdDeps): void {
  const channel = new deps.BroadcastChannel(tabId);
  channel.onmessage = () => {
    channel.postMessage('in-use');
  };
  // Note: channel stays open for lifetime of tab (no close)
}

/**
 * Probe whether another tab is already using this tabId.
 *
 * Opens a BroadcastChannel with the tabId as the channel name,
 * sends a 'probe' message, and waits up to PROBE_TIMEOUT_MS for
 * an 'in-use' response.
 *
 * @returns true if another tab responded (tabId is in use)
 */
function checkTabIdInUse(tabId: string, deps: TabIdDeps): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new deps.BroadcastChannel(tabId);
    const timeout = setTimeout(() => {
      channel.close();
      resolve(false); // No response — tabId is available
    }, PROBE_TIMEOUT_MS);

    channel.onmessage = () => {
      clearTimeout(timeout);
      channel.close();
      resolve(true); // Got response — tabId is in use
    };

    channel.postMessage('probe');
  });
}
