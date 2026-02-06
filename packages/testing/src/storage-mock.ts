/**
 * Memory-backed Storage mock for testing
 *
 * Implements the Web Storage API (sessionStorage/localStorage interface)
 * backed by an in-memory Map. Does NOT implement Proxy-based index access
 * (storage['key'] or storage[0]) — use getItem()/setItem() methods only.
 *
 * Known limitations vs real Storage:
 * - No Proxy-based property access (storage.key or storage['key'])
 * - No StorageEvent dispatching
 * - No storage quota enforcement
 *
 * @internal
 */
export class StorageMock implements Storage {
  #data: Map<string, string>;

  constructor(initial?: Map<string, string>) {
    this.#data = initial ?? new Map();
  }

  get length(): number {
    return this.#data.size;
  }

  key(index: number): string | null {
    const keys = [...this.#data.keys()];
    return keys[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#data.delete(key);
  }

  clear(): void {
    this.#data.clear();
  }

  /**
   * Create a clone of this storage (for duplicateContext)
   * Returns a new StorageMock with a copy of all current data.
   */
  clone(): StorageMock {
    return new StorageMock(new Map(this.#data));
  }
}
