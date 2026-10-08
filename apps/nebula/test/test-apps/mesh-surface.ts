/**
 * Every member a request's chain can open on, for a host class — read the way the entry rule looks
 * for `@mesh()` (`descriptor.get ?? descriptor.value`, `decoratedFunctionOf` in `ocan/execute.ts`),
 * over the WHOLE prototype chain, nearest definition first.
 *
 * Both halves matter. A walk of one prototype misses what a host inherits — `ScopedMeshDO.teardown` is
 * wire-reachable on every host — and a `descriptor.value` walk misses a getter gate like
 * `resources`. An override without `@mesh()` shadows a decorated base method or getter, and the
 * entry rule refuses it, so the nearest definition is the one that counts.
 */
import { isMeshCallable, getMeshGuard } from '@lumenize/mesh';

export interface MeshEntry {
  name: string;
  /** The guard passed to `@mesh()`; `undefined` for a bare `@mesh()`. Compare by identity. */
  guard: unknown;
}

export function meshEntries(ctor: { prototype: object }): MeshEntry[] {
  const seen = new Set<string>();
  const out: MeshEntry[] = [];
  for (let proto: object | null = ctor.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const d = Object.getOwnPropertyDescriptor(proto, name)!;
      const fn = d.get ?? d.value;
      if (typeof fn === 'function' && isMeshCallable(fn)) out.push({ name, guard: getMeshGuard(fn) });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
