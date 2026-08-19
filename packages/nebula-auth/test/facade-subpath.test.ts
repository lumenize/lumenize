/**
 * The facade subpath boundary — `NebulaAuthFacade` composes `@lumenize/mesh` (a `LumenizeWorker`
 * carrying `@mesh()` decorators), and pulling that chain through the widely-imported root barrel
 * breaks the transform of pure-unit consumers that import the index only for light utilities (a
 * bare `SyntaxError` with no location — packaging.md § Standard package files). It is reachable
 * only via `@lumenize/nebula-auth/facade`.
 *
 * Reds against re-exporting the class from `src/index.ts` — the shape the hazard actually takes —
 * in BOTH available ways at once: the export lands in the namespace (the assertion), and this very
 * file then fails to transform (this lane has no decorator plugin), which is the hazard
 * demonstrating itself. ⚠️ Do NOT add a dynamic import of the facade here as a positive control —
 * it dies on the same missing transform; the positive control (the subpath is importable and the
 * class works end-to-end) is the baseline lane's `invite-facade.test.ts`, whose test app imports
 * `@lumenize/nebula-auth/facade` under a decorator-aware transform.
 */
import { describe, it, expect } from 'vitest';
import * as barrel from '../src/index';

describe('facade subpath boundary', () => {
  it('the root barrel does not carry the mesh-composing facade', () => {
    expect('NebulaAuthFacade' in barrel).toBe(false);
  });
});
