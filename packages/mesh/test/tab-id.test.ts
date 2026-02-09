/**
 * Tests for tab-id.ts — getOrCreateTabId with Browser contexts
 *
 * Uses Browser.context() and Browser.duplicateContext() from @lumenize/testing
 * to simulate real browser tab behavior: independent sessionStorage per tab,
 * shared BroadcastChannel within same origin.
 */

import { describe, it, expect } from 'vitest';
import { Browser } from '@lumenize/testing';
import { getOrCreateTabId } from '../src/tab-id';

describe('getOrCreateTabId', () => {
  describe('fresh tab (no stored tabId)', () => {
    it('generates a tabId and stores it in sessionStorage', async () => {
      const browser = new Browser();
      const tab = browser.context('https://example.com');

      const tabId = await getOrCreateTabId(tab);

      expect(tabId).toMatch(/^[0-9a-f]{8}$/);
      expect(tab.sessionStorage.getItem('lmz_tab')).toBe(tabId);
    });

    it('generates different tabIds for independent tabs', async () => {
      const browser = new Browser();
      const tab1 = browser.context('https://example.com');
      const tab2 = browser.context('https://example.com');

      const id1 = await getOrCreateTabId(tab1);
      const id2 = await getOrCreateTabId(tab2);

      expect(id1).not.toBe(id2);
    });
  });

  describe('returning tab (stored tabId, no conflict)', () => {
    it('reuses the stored tabId when no other tab claims it', async () => {
      const browser = new Browser();
      const tab = browser.context('https://example.com');

      const id1 = await getOrCreateTabId(tab);
      // Simulate page reload: JS state (BroadcastChannel listeners) torn down,
      // but sessionStorage persists
      tab.closeChannels();
      const id2 = await getOrCreateTabId(tab);

      expect(id2).toBe(id1);
    });
  });

  describe('duplicate tab detection', () => {
    it('detects a duplicated tab and generates a new tabId', async () => {
      const browser = new Browser();
      const tab1 = browser.context('https://example.com');

      // Tab 1 gets its tabId — sets up listener
      const id1 = await getOrCreateTabId(tab1);

      // Browser duplicates tab1 → sessionStorage cloned
      const tab2 = browser.duplicateContext(tab1);
      expect(tab2.sessionStorage.getItem('lmz_tab')).toBe(id1); // cloned

      // Tab 2 calls getOrCreateTabId — should detect conflict via BroadcastChannel
      const id2 = await getOrCreateTabId(tab2);

      expect(id2).not.toBe(id1);
      expect(id2).toMatch(/^[0-9a-f]{8}$/);
      expect(tab2.sessionStorage.getItem('lmz_tab')).toBe(id2);
      // Tab 1 unchanged
      expect(tab1.sessionStorage.getItem('lmz_tab')).toBe(id1);
    });

    it('allows a second duplicate to also get a unique tabId', async () => {
      const browser = new Browser();
      const tab1 = browser.context('https://example.com');

      const id1 = await getOrCreateTabId(tab1);

      // Two duplicates of the original tab
      const tab2 = browser.duplicateContext(tab1);
      const id2 = await getOrCreateTabId(tab2);

      const tab3 = browser.duplicateContext(tab1);
      const id3 = await getOrCreateTabId(tab3);

      // All three are unique
      const ids = new Set([id1, id2, id3]);
      expect(ids.size).toBe(3);
    });
  });
});
