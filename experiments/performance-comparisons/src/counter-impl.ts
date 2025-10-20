// Shared counter implementation used by both RPC systems
// This ensures we're only measuring RPC overhead, not business logic differences

export class CounterImpl {
  constructor(private storage: DurableObjectStorage) {}

  increment(amount: number): number {
    const current = this.storage.kv.get<number>('count') ?? 0;
    const newValue = current + amount;
    this.storage.kv.put('count', newValue);
    return newValue;
  }

  getValue(): number {
    return this.storage.kv.get<number>('count') ?? 0;
  }

  reset(): void {
    this.storage.kv.delete('count');
  }
}

export interface Counter {
  increment(amount: number): number;
  getValue(): number;
  reset(): void;
}
