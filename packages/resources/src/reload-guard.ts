/**
 * What a reload guard keeps in a tab's `sessionStorage` (ADR-024): the version a refresh was for,
 * and the version the tab ran when it asked. The Client's ontology guard and a framed page's build
 * guard each keep one under a key of its own. A guard stays put only while both still hold, so a
 * refresh that did not take, a stale cache bringing the old page back, stops its loop, while a tab
 * that has since moved to another version is asked again, a return to the version it once
 * refreshed for included.
 */
export interface ReloadGuard {
  /** The version the tab was asked to move to. */
  for: string;
  /** The version the tab ran when it was asked; absent when the page named none. */
  from?: string;
}

/** Whether `guard` already covers a request to move a tab running `own` to `named`. */
export function guardHolds(guard: ReloadGuard | undefined, named: string, own: string | undefined): boolean {
  return guard !== undefined && guard.for === named && guard.from === own;
}

/** The guard a refresh from `own` to `named` records. */
export function guardFor(named: string, own: string | undefined): ReloadGuard {
  return own === undefined ? { for: named } : { for: named, from: own };
}

/** The guard under `key`, or none where storage is absent or blocked, or holds anything else. */
export function readReloadGuard(storage: Storage | undefined, key: string): ReloadGuard | undefined {
  try {
    const value = JSON.parse(storage?.getItem(key) ?? 'null') as { for?: unknown; from?: unknown } | null;
    if (typeof value?.for !== 'string') return undefined;
    if (value.from !== undefined && typeof value.from !== 'string') return undefined;
    return guardFor(value.for, value.from);
  } catch {
    return undefined;
  }
}

export function writeReloadGuard(storage: Storage | undefined, key: string, guard: ReloadGuard): void {
  try { storage?.setItem(key, JSON.stringify(guard)); } catch { /* storage blocked */ }
}
