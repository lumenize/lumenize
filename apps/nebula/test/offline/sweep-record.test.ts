/**
 * What `drive.ts all --rerun` keeps between sweeps, and which scenarios it runs again. In the Node
 * lane rather than `/live`: the record is files and hashes, and a sweep that proves it takes half an
 * hour, so the decision is pinned here and the command was driven once by hand (`live.md` says when
 * to use it).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPaths, isFlake, namesToRerun, readRecord, writeRecord } from '../../harness/lib/sweep-record';
import type { SweepRecord } from '../../harness/lib/sweep-record';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sweep-record-'));
  mkdirSync(join(root, 'src/node_modules'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('hashPaths', () => {
  it('moves when a file under it changes, and stays put when nothing does', () => {
    const before = hashPaths(root, ['src']);
    expect(hashPaths(root, ['src'])).toBe(before);
    writeFileSync(join(root, 'src/a.ts'), 'export const a = 2;');
    expect(hashPaths(root, ['src'])).not.toBe(before);
  });

  it('skips installed dependencies', () => {
    // Mutation: drop `node_modules` from the skipped names → red.
    const before = hashPaths(root, ['src']);
    writeFileSync(join(root, 'src/node_modules/dep.js'), 'module.exports = 1;');
    expect(hashPaths(root, ['src'])).toBe(before);
  });

  it('hashes a path that names a single file, and moves when one that was absent is created', () => {
    // `wrangler.jsonc` and `package-lock.json` are such paths. Mutation: walk directories only → red.
    const before = hashPaths(root, ['src', 'config.json']);
    writeFileSync(join(root, 'config.json'), '{}');
    expect(hashPaths(root, ['src', 'config.json'])).not.toBe(before);
  });
});

describe('namesToRerun', () => {
  const files: Record<string, string> = { a: 'fa', b: 'fb', c: 'fc', d: 'fd' };
  const record: SweepRecord = {
    tree: 't1',
    scenarios: {
      a: { ok: true, file: 'fa', at: '2026-10-15T00:00:00.000Z' },
      b: { ok: false, file: 'fb', at: '2026-10-15T00:00:00.000Z' },
      c: { ok: true, file: 'old', at: '2026-10-15T00:00:00.000Z' },
    },
  };

  it('on the same tree, skips each pass from an unchanged file and runs the rest', () => {
    // Mutations: skip a failure, keep a pass whose file changed, or skip a scenario never run → red.
    expect(namesToRerun(['a', 'b', 'c', 'd'], record, 't1', (n) => files[n]!)).toEqual(['b', 'c', 'd']);
  });

  it('on another tree, or with no record, runs every one', () => {
    // Mutation: keep passes whatever the tree → red.
    expect(namesToRerun(['a', 'b'], record, 't2', (n) => files[n]!)).toEqual(['a', 'b']);
    expect(namesToRerun(['a', 'b'], undefined, 't1', (n) => files[n]!)).toEqual(['a', 'b']);
  });
});

describe('the record on disk', () => {
  it('reads back what was written, and nothing from a file that is not one', () => {
    const path = join(root, 'sweep/results-local.json');
    const record: SweepRecord = { tree: 't1', scenarios: { a: { ok: true, file: 'fa', at: '2026-10-15T00:00:00.000Z' } } };
    writeRecord(path, record);
    expect(readRecord(path)).toEqual(record);
    writeFileSync(path, 'not json');
    expect(readRecord(path)).toBeUndefined();
    expect(readRecord(join(root, 'absent.json'))).toBeUndefined();
  });
});

describe('isFlake', () => {
  // Mutation: drop the file comparison → the changed-file row reds.
  it.each([
    ['failed on this tree, passes now from the same file', { ok: false, file: 'f', at: '' }, 'f', true, true],
    ['failed, passes now from a changed file: a fix, not a flake', { ok: false, file: 'old', at: '' }, 'f', true, false],
    ['passed before and passes now', { ok: true, file: 'f', at: '' }, 'f', true, false],
    ['failed before and fails now', { ok: false, file: 'f', at: '' }, 'f', false, false],
    ['never ran on this tree', undefined, 'f', true, false],
  ] as const)('%s', (_name, prior, file, okNow, flake) => {
    expect(isFlake(prior, file, okNow)).toBe(flake);
  });
});
