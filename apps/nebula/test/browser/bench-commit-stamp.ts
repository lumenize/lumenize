/**
 * Bench results commit-stamp (Phase 2: tasks/nebula-release-process.md).
 *
 * Node-only — imported solely by the `*.benchmark.ts` files, which run in vitest's Node context
 * (they already import `node:fs`/`node:path`/`node:url`). Deliberately NOT in `test-helpers.ts`,
 * which is also imported by browser-context tests where `node:child_process` would break the bundle.
 *
 * Prepends the local HEAD commit a results file was measured at. For a deployed (`BENCH_BASE_URL`)
 * run, global-setup's staleness guard has ALREADY confirmed deployed === HEAD before any test ran,
 * so the cited SHA is exactly what was measured — no drift, and no hand-typed footnote to forget.
 * The machine-greppable marker line lets the Phase-2 criterion verify with
 * `grep -L "$(git rev-parse HEAD)" apps/nebula/test/browser/*-deployed.md` (empty = all stamped).
 */
import { execSync } from 'node:child_process';

/** Prepend a greppable + human-readable `measured-at-commit` stamp to a generated results body. */
export function withCommitStamp(markdown: string): string {
  const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
  return (
    `<!-- measured-at-commit: ${sha} -->\n` +
    `> Measured at commit \`${sha}\`${dirty ? ' ⚠️ dirty tree — not reproducible' : ''}.\n\n` +
    markdown
  );
}
