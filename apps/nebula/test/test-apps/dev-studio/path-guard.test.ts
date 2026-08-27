/**
 * The write_file path-traversal guard (`assertSafeRelPath`, codegen-loop.ts), operand by
 * operand. The loop-level D5a tests (codegen-loop.test.ts) prove a rejected path never
 * reaches `writeFile`; this file enumerates the guard's own operand fan-out — including
 * the backslash separator and the empty/non-string shapes the loop fixtures don't reach.
 */
import { describe, it, expect } from 'vitest';
import { assertSafeRelPath } from '../../../src/codegen-loop';

describe('write_file path-traversal guard (assertSafeRelPath)', () => {
  // Positive control: an in-tree relative path is accepted (no throw). If this
  // threw, the guard would be rejecting legitimate writes (capable-of-failing).
  it('accepts an in-tree relative path', () => {
    expect(() => assertSafeRelPath('src/App.vue')).not.toThrow();
    expect(() => assertSafeRelPath('src/components/TodoList.vue')).not.toThrow();
    expect(() => assertSafeRelPath('ontology.d.ts')).not.toThrow();
  });

  // Negative 1: a `..` traversal segment is rejected (either separator). Mutation-check:
  // deleting the `..`-segment branch lets these through → RED.
  it('rejects a ../ traversal path (writes nothing)', () => {
    expect(() => assertSafeRelPath('../etc/evil')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src/../../escape')).toThrow(/'\.\.' segment/);
    expect(() => assertSafeRelPath('src\\..\\..\\escape')).toThrow(/'\.\.' segment/);
  });

  // Negative 2: an absolute path is rejected. Mutation-check: deleting the
  // `startsWith('/')` branch lets this through → RED. (Distinct operand from the
  // `..` check — both must be enumerated, testing.md compound-condition rule.)
  it('rejects an absolute path (writes nothing)', () => {
    expect(() => assertSafeRelPath('/etc/passwd')).toThrow(/[Aa]bsolute/);
    expect(() => assertSafeRelPath('/workspace/src/App.vue')).toThrow(/[Aa]bsolute/);
  });

  it('rejects an empty / non-string path', () => {
    expect(() => assertSafeRelPath('')).toThrow(/Invalid source path/);
    expect(() => assertSafeRelPath(undefined as unknown as string)).toThrow(/Invalid source path/);
  });
});
