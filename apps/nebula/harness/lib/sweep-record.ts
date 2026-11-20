/**
 * What a sweep's passes are evidence about, kept between sweeps so `drive.ts all --rerun` runs
 * only the scenarios that have not passed on the tree in front of it.
 *
 * A pass is evidence about three things: the code the stack runs, the harness that drives it, and
 * the scenario's own file. A rerun keeps a pass only while all three are what they were when it
 * passed. So a fix confined to one scenario's file reruns that scenario alone, and any edit to the
 * code or the harness reruns everything, as `live.md`'s sweep rule asks. A sweep records each
 * scenario as it finishes, so a sweep stopped part way resumes with `--rerun` too.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The harness's own code: everything it runs but the scenarios, and what it imports from outside. */
export const HARNESS_PATHS = [
  'apps/nebula/harness/drive.ts', 'apps/nebula/harness/lib', 'apps/nebula/test/lib', 'apps/nebula/scripts',
];

/**
 * What a local stack runs beyond the files `wrangler dev` watches: its config, the dependencies the
 * lockfile pins, and Studio, which vite serves from source.
 */
export const LOCAL_STACK_EXTRA_PATHS = [
  'apps/nebula/wrangler.jsonc', 'package-lock.json',
  'apps/nebula-studio-ui/src', 'apps/nebula-studio-ui/index.html', 'apps/nebula-studio-ui/vite.config.ts',
];

/** The file each registered scenario lives in, which the registry names after it. */
export const scenarioPath = (name: string): string => `apps/nebula/harness/scenarios/${name}.ts`;

const SKIPPED_DIRS = new Set(['node_modules', '.wrangler', 'dist', '.artifacts']);

/**
 * A hash of every file under `paths`, each a file or a directory relative to `repoRoot`, by path and
 * content. A path that does not exist adds nothing, so creating it changes the hash.
 */
export function hashPaths(repoRoot: string, paths: string[]): string {
  const h = createHash('sha1');
  const walk = (full: string): void => {
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(full); } catch { return; }
    if (stat.isFile()) { h.update(`${full}\n`); h.update(readFileSync(full)); return; }
    if (!stat.isDirectory()) return;
    for (const e of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory() && SKIPPED_DIRS.has(e.name)) continue;
      walk(join(full, e.name));
    }
  };
  for (const p of paths) walk(join(repoRoot, p));
  return h.digest('hex');
}

/** One scenario's last verdict on a tree, and the hash of its file when it ran. */
export interface ScenarioVerdict {
  ok: boolean;
  file: string;
  at: string;
}

/** Every verdict recorded on one tree. A sweep on another tree starts a fresh record. */
export interface SweepRecord {
  tree: string;
  scenarios: Record<string, ScenarioVerdict>;
}

export function readRecord(path: string): SweepRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as SweepRecord;
    return typeof record.tree === 'string' && typeof record.scenarios === 'object' ? record : undefined;
  } catch {
    return undefined;
  }
}

export function writeRecord(path: string, record: SweepRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
}

/**
 * Which of `names` a rerun on `tree` must run: each one without a pass recorded on that tree from
 * the file it has now. On another tree, or with no record, that is every one.
 */
export function namesToRerun(
  names: string[], record: SweepRecord | undefined, tree: string, fileHashOf: (name: string) => string,
): string[] {
  if (record?.tree !== tree) return names;
  return names.filter((n) => {
    const v = record.scenarios[n];
    return !(v?.ok === true && v.file === fileHashOf(n));
  });
}

/**
 * Whether a pass now is a flake: the scenario failed on this same tree, from this same file, and
 * passed when run again with nothing changed.
 */
export function isFlake(prior: ScenarioVerdict | undefined, file: string, okNow: boolean): boolean {
  return okNow && prior !== undefined && !prior.ok && prior.file === file;
}
