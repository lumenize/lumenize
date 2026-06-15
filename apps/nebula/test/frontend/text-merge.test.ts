/**
 * textMerge property tests — ported from the factory-textmerge isolation detour
 * (apps/nebula/spike/vue-factory/test/text-merge.test.ts; tasks/factory-textmerge.md
 * § Property tests). Each `describe` maps to one pinned property from the spec.
 * No mock-client needed — pure helper.
 */
import { describe, it, expect } from 'vitest';
import { textMerge, makeLongformResolver } from '../../src/frontend/text-merge';

describe('identity / degeneration (the B4 trap)', () => {
  it('server === base ⇒ result === local (only local changed)', () => {
    expect(textMerge('the cat sat', 'a cat sat', 'the cat sat')).toBe('a cat sat');
  });

  it('local === base ⇒ result === server (only server changed)', () => {
    expect(textMerge('the cat stood', 'the cat sat', 'the cat sat')).toBe('the cat stood');
  });

  it('local === server ⇒ that value, even when both diverged from base', () => {
    expect(textMerge('same edit', 'same edit', 'original')).toBe('same edit');
  });

  it('all three identical ⇒ that value', () => {
    expect(textMerge('unchanged', 'unchanged', 'unchanged')).toBe('unchanged');
  });

  it('B4 trap demonstrated: an impl handed base=server collapses to local-wins and DROPS the server edit', () => {
    // This is the regression the degeneration tests above catch. A merge
    // anchored at the server snapshot instead of the true common ancestor:
    const b4TrapMerge = (server: string, local: string, _base: string) =>
      textMerge(server, local, server);
    const base = 'the cat sat';
    const local = 'a cat sat'; // local edits the start
    const server = 'the cat stood'; // concurrent server edit at the end
    // Correct merge preserves both sides:
    expect(textMerge(server, local, base)).toContain('stood');
    // The trapped merge silently loses the server edit:
    const trapped = b4TrapMerge(server, local, base);
    expect(trapped).toBe(local);
    expect(trapped).not.toContain('stood');
  });
});

describe('both edits preserved (non-overlapping)', () => {
  it('local edits the start, server edits the end — both survive', () => {
    const merged = textMerge('the cat stood', 'a cat sat', 'the cat sat');
    expect(merged).toBe('a cat stood');
  });

  it('edits at start and end of a longer sentence', () => {
    const base = 'the cat sat on the mat';
    const local = 'a cat sat on the mat'; // start
    const server = 'the cat sat on a rug'; // end
    expect(textMerge(server, local, base)).toBe('a cat sat on a rug');
  });

  it('local inserts a word, server appends at the end', () => {
    const base = 'the cat sat';
    const local = 'the fluffy cat sat';
    const server = 'the cat sat quietly';
    expect(textMerge(server, local, base)).toBe('the fluffy cat sat quietly');
  });

  it('local deletes a leading word, server edits a trailing word', () => {
    const base = 'well the cat sat';
    const local = 'the cat sat';
    const server = 'well the cat stood';
    expect(textMerge(server, local, base)).toBe('the cat stood');
  });
});

describe('overlap is bounded, not silent', () => {
  it('both replace the same word differently — local side wins the span (documented garble)', () => {
    const merged = textMerge('the Cat sat', 'the kat sat', 'the cat sat');
    expect(merged).toBe('the kat sat');
  });

  it('both insert at the same point — one side survives, never a crash', () => {
    const merged = textMerge('hello new world', 'hello brave world', 'hello world');
    expect(merged).toBe('hello brave world');
  });

  it('local deletes a span the server edited — the server edit survives (deletion never erases an edit)', () => {
    const merged = textMerge('the lion sat', 'the sat', 'the cat sat');
    expect(merged).toContain('lion');
    expect(merged).not.toBe('');
  });

  it('local deleted everything while server edited — never an empty result', () => {
    const merged = textMerge('the cat stood', '', 'the cat sat');
    expect(merged).toBe('the cat stood');
  });

  it('server deleted everything while local edited — local side survives', () => {
    const merged = textMerge('', 'the cat napped', 'the cat sat');
    expect(merged).toBe('the cat napped');
  });
});

describe('empty / edge', () => {
  it('empty base, both sides typed different text — one side, non-empty, no crash', () => {
    expect(textMerge('world', 'hello', '')).toBe('hello');
  });

  it('empty base, only local typed (server === base) ⇒ local', () => {
    expect(textMerge('', 'hello', '')).toBe('hello');
  });

  it('empty base, only server typed (local === base) ⇒ server', () => {
    expect(textMerge('world', '', '')).toBe('world');
  });

  it("both sides deleted everything ⇒ '' per the identity rule", () => {
    expect(textMerge('', '', 'the cat sat')).toBe('');
  });

  it("local deleted everything, server unchanged ⇒ '' (deletion is the only edit)", () => {
    expect(textMerge('the cat sat', '', 'the cat sat')).toBe('');
  });

  it('single-char: one side edited', () => {
    expect(textMerge('a', 'b', 'a')).toBe('b');
    expect(textMerge('c', 'a', 'a')).toBe('c');
  });

  it('single-char: both edited differently — local wins, no crash', () => {
    expect(textMerge('c', 'b', 'a')).toBe('b');
  });

  it('whitespace-only edits round-trip exactly', () => {
    expect(textMerge('the  cat', 'the cat sat', 'the cat')).toContain('cat');
    expect(textMerge('a\nb', 'a b', 'a b')).toBe('a\nb');
  });

  it('multi-line text: non-overlapping edits on different lines both survive', () => {
    const base = 'line one\nline two\nline three';
    const local = 'line ONE\nline two\nline three';
    const server = 'line one\nline two\nline THREE';
    expect(textMerge(server, local, base)).toBe('line ONE\nline two\nline THREE');
  });
});

describe('determinism (pure function of its three args)', () => {
  const cases: Array<[string, string, string]> = [
    ['the cat stood', 'a cat sat', 'the cat sat'],
    ['the Cat sat', 'the kat sat', 'the cat sat'],
    ['hello new world', 'hello brave world', 'hello world'],
    ['world', 'hello', ''],
    ['', '', 'the cat sat'],
    ['c', 'b', 'a'],
    ['the lion sat', 'the sat', 'the cat sat'],
  ];

  it('same inputs ⇒ same output, across repeated and interleaved calls', () => {
    const first = cases.map(([s, l, b]) => textMerge(s, l, b));
    // Interleave unrelated calls, then re-run the battery.
    textMerge('x y z', 'x q z', 'x y z');
    const second = cases.map(([s, l, b]) => textMerge(s, l, b));
    expect(second).toEqual(first);
  });
});

describe("round-trip in a 'use-this' resolver (the @longform shape)", () => {
  const resolver = makeLongformResolver('body');
  const base = { title: 'Doc', body: 'the cat sat' };
  const local = { title: 'Doc', body: 'a cat sat' };
  const server = { title: 'Doc (renamed)', body: 'the cat stood' };
  const conflictPending = {
    kind: 'conflict-pending' as const,
    local: { value: local, eTag: 'etag-base' },
    server: { value: server, meta: { eTag: 'etag-2' } },
    base: { value: base, eTag: 'etag-base' },
  };

  it("returns { kind: 'use-this' } with the server value plus the merged @longform field", () => {
    const verdict = resolver(conflictPending);
    expect(verdict).toEqual({
      kind: 'use-this',
      value: { title: 'Doc (renamed)', body: 'a cat stood' },
    });
    // The merged field is exactly what textMerge produces from the three bodies
    // — this value is what gets re-submitted.
    expect((verdict as { value: { body: string } }).value.body).toBe(
      textMerge(server.body, local.body, base.body),
    );
  });

  it('concurrent non-overlapping edits both survive the resolver (capable-of-failing vs a base=server impl)', () => {
    const verdict = resolver(conflictPending) as { value: { body: string } };
    expect(verdict.value.body).toContain('a cat'); // local's edit
    expect(verdict.value.body).toContain('stood'); // server's edit — dropped by a base=server impl
  });

  it('non-conflict-pending kinds fall through (undefined, M9)', () => {
    expect(resolver({ kind: 'committed' })).toBeUndefined();
    expect(resolver({ kind: 'use-server' })).toBeUndefined();
    expect(resolver({ kind: 'validation-failed' })).toBeUndefined();
  });

  it('a never-set optional @longform field merges as empty string, no crash', () => {
    const v = resolver({
      kind: 'conflict-pending',
      local: { value: { title: 'a' } },
      server: { value: { title: 'b' } },
      base: { value: { title: 'c' } },
    }) as { kind: string; value: Record<string, unknown> };
    expect(v.kind).toBe('use-this');
    expect(v.value.body).toBe('');
  });
});
