/**
 * The entries' path rule (`assertModelPath`, galaxy.ts), operand by operand. It runs FIRST
 * inside `readSource` and `writeSource`, so a direct client call and a loop tool agree on
 * what a path may name; `codegen-loop.test.ts` proves a rejected path never lands through
 * the loop, and `source-chat-floor.test.ts` (baseline) proves it through a real client.
 * This file enumerates the guard's own operand fan-out, including the shapes those
 * fixtures don't reach: the backslash separator, the empty/non-string path, the `./`
 * normalisation, and the write-only reserved-prefix operand with its one exception.
 */
import { describe, it, expect } from 'vitest';
import { assertModelPath } from '../../../src/galaxy';

const W = { write: true } as const;
const R = { write: false } as const;

describe('the entries\' path rule (assertModelPath)', () => {
  // Positive control: an in-tree relative path is accepted and returned unchanged. If
  // this threw, the rule would be rejecting legitimate writes (capable-of-failing).
  it('accepts an in-tree relative path, for read and write', () => {
    expect(assertModelPath('src/App.vue', W)).toBe('src/App.vue');
    expect(assertModelPath('src/components/TodoList.vue', W)).toBe('src/components/TodoList.vue');
    expect(assertModelPath('AGENTS.md', W)).toBe('AGENTS.md');
    expect(assertModelPath('src/App.vue', R)).toBe('src/App.vue');
  });

  it('normalises a leading ./ (so a model-written "./src/App.vue" names the same file)', () => {
    expect(assertModelPath('./src/App.vue', W)).toBe('src/App.vue');
    expect(assertModelPath('././docs/vision.md', R)).toBe('docs/vision.md');
  });

  // Negative 1: a `..` traversal segment is rejected (either separator). Mutation-check:
  // deleting the `..`-segment branch lets these through → RED.
  it('rejects a ../ traversal path', () => {
    expect(() => assertModelPath('../etc/evil', W)).toThrow(/'\.\.' segment/);
    expect(() => assertModelPath('src/../../escape', W)).toThrow(/'\.\.' segment/);
    expect(() => assertModelPath('src\\..\\..\\escape', W)).toThrow(/'\.\.' segment/);
    expect(() => assertModelPath('../x', R)).toThrow(/'\.\.' segment/);
  });

  // Negative 2: an absolute path is rejected — a distinct operand from the `..` check
  // (testing.md compound-condition rule). Mutation-check: deleting the absolute branch lets
  // this through → RED. A `./` prefix cannot launder it: `.//etc` normalises to `/etc`.
  it('rejects an absolute path', () => {
    expect(() => assertModelPath('/etc/passwd', W)).toThrow(/[Aa]bsolute/);
    expect(() => assertModelPath('/workspace/src/App.vue', W)).toThrow(/[Aa]bsolute/);
    expect(() => assertModelPath('.//etc/passwd', W)).toThrow(/[Aa]bsolute/);
    expect(() => assertModelPath('/src/App.vue', R)).toThrow(/[Aa]bsolute/);
  });

  it('rejects an empty / non-string path', () => {
    expect(() => assertModelPath('', W)).toThrow(/Invalid source path/);
    expect(() => assertModelPath(undefined as unknown as string, W)).toThrow(/Invalid source path/);
  });

  // Negative 3: the reserved prefixes — every leading-dot FIRST segment on a write, except
  // `.agents`. Each is its own case because each guards a different thing: a registry row
  // `#registryRows()` would parse, a platform doc a user app could shadow, the Universe
  // mount, git's own tree, a secret's file. Mutation-check: deleting the dot-prefix branch
  // lets every one of these through → RED; special-casing `.nebula` alone leaves the rest.
  it.each([
    ['.nebula/ontology/0123456789abcdef0123456789abcdef01234567.json'],
    ['.nebula/ontology-row.json'],
    ['.platform/AGENTS.md'],
    ['.platform/docs/resources.md'],
    ['.universe/AGENTS.md'],
    ['.git/config'],
    ['.env'],
    ['.gitignore'],
    ['./.env'],
  ])('refuses a WRITE to the reserved path %s', (path) => {
    expect(() => assertModelPath(path, W)).toThrow(/Reserved path rejected/);
  });

  // The one exception, and the reads: `.agents/` is the user-developer's skills directory
  // (writable), and a READ of a dot path stays allowed — the build box reads `.git/index`
  // and the compiled row. Positive controls for the `it.each` above.
  it('allows a write under .agents/ and a read of any dot path', () => {
    expect(assertModelPath('.agents/skills/define-ontology/SKILL.md', W)).toBe('.agents/skills/define-ontology/SKILL.md');
    expect(assertModelPath('.git/index', R)).toBe('.git/index');
    expect(assertModelPath('.nebula/ontology-row.json', R)).toBe('.nebula/ontology-row.json');
    expect(assertModelPath('.platform/AGENTS.md', R)).toBe('.platform/AGENTS.md');
  });

  // A dot INSIDE a path is not a reserved prefix — the rule is on the first segment only.
  it('does not mistake a dotted filename or a nested dot directory for a reserved prefix', () => {
    expect(assertModelPath('src/ontology.d.ts', W)).toBe('src/ontology.d.ts');
    expect(assertModelPath('src/.hidden/x.ts', W)).toBe('src/.hidden/x.ts');
  });
});
