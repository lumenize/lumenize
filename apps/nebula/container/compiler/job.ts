/**
 * The in-container build job — every build-like step runs HERE, and the Worker only
 * orchestrates and stores (tasks/archive/nebula-move-compilers-out-of-the-worker.md, the prime
 * directive). Bundled to `/build/job.cjs` at image build; the Galaxy execs
 * `node /build/job.cjs` against the FUSE-mounted `/workspace` and parses the report
 * line off stdout.
 *
 * Three steps, run UNCONDITIONALLY in order — no step gates another (a type finding
 * never stops the bundle: `@vitejs/plugin-vue` transpiles rather than type-checks, so a
 * `.vue` carrying a real TS2339 still produces a `dist`, and stopping there would make
 * the model's preview override unreachable by construction). Only `bundle`'s own
 * failure means there is no `dist`:
 *
 *   1. ontology  — when the host passed ONTOLOGY_VERSION: compile
 *                  `src/ontology.d.ts` to its OntologyVersionRow and write the row
 *                  JSON at ROW_PATH in the mount (the Galaxy reads it back host-side
 *                  with `ws.fs.readFile`; `runtime.exec` returns only stdio, and a
 *                  bulky emitted module has no reader in the model's tool result).
 *                  `version` + `wipeOnInstall` are HOST-computed and passed IN, never
 *                  read back out — `version` keys the Star's Worker Loader cache, and
 *                  the wipe bit was decided under a dominion check in the turn that
 *                  changed the ontology.
 *   2. typeCheck — both SFC passes over every `.vue` under `src/` (see ./sfc-check).
 *                  `checked` lists what tsc actually looked at, so a file written,
 *                  checked and unimplicated is KNOWN CLEAN. No `ok` — advisory by
 *                  type, the model judges the findings.
 *   3. bundle    — `vite build` (the baked image deps at `/node_modules`, per the
 *                  Dockerfile header).
 *
 * The report rides ONE stdout line prefixed REPORT_MARKER; step tails are bounded
 * RAW output (never summarized — line numbers and error codes are what a model
 * reads fluently).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileOntologyVersion } from '../../src/ontology-compile';
// The report SHAPE + marker live in the shared leaf so the Worker side cannot drift.
import { createHash } from 'node:crypto';
import { REPORT_MARKER, ROW_PATH } from '../../src/build-report';
import type { JobReport, StepResult } from '../../src/build-report';
import { checkVueSfc } from './sfc-check';

const MAX_TAIL = 4000;

/** The LAST `n` chars — build/exec output is bounded from the tail, where the error is. */
function tail(text: string, n = MAX_TAIL): string {
  return text.length > n ? '…' + text.slice(-n) : text;
}

function walkVueFiles(dir: string, rel = 'src'): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(join(dir, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkVueFiles(dir, relPath));
    else if (e.name.endsWith('.vue')) out.push(relPath);
  }
  return out;
}

export function runJob(workspace: string, opts: { ontologyVersion?: string; wipeOnInstall?: boolean }): JobReport {
  // ── 1. ontology ─────────────────────────────────────────────────────────
  let ontology: JobReport['ontology'];
  if (!opts.ontologyVersion) {
    ontology = { ran: false, why: 'no ontology change (host passed no version)' };
  } else {
    try {
      const types = readFileSync(join(workspace, 'src/ontology.d.ts'), 'utf8');
      const row = compileOntologyVersion({
        version: opts.ontologyVersion,
        types,
        ...(opts.wipeOnInstall ? { wipeOnInstall: true } : {}),
      });
      mkdirSync(join(workspace, '.nebula'), { recursive: true });
      writeFileSync(join(workspace, ROW_PATH), JSON.stringify(row));
      ontology = { ran: true, ok: true, rowPath: ROW_PATH };
    } catch (e) {
      ontology = { ran: true, ok: false, tail: tail(e instanceof Error ? e.message : String(e)) };
    }
  }

  // ── 2. typeCheck (advisory — never gates) ───────────────────────────────
  const checked: string[] = [];
  const findings: string[] = [];
  for (const relPath of walkVueFiles(workspace)) {
    try {
      const source = readFileSync(join(workspace, relPath), 'utf8');
      checked.push(relPath);
      findings.push(...checkVueSfc(relPath, source).findings);
    } catch (e) {
      findings.push(`${relPath}: check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Bound the total like the tails — a runaway diagnostic list must not bloat the
  // tool result or the persisted codegen record.
  let budget = MAX_TAIL;
  const bounded: string[] = [];
  for (const f of findings) {
    if (budget <= 0) {
      bounded.push(`…(${findings.length - bounded.length} more findings truncated)`);
      break;
    }
    bounded.push(f.length > budget ? f.slice(0, budget) + '…' : f);
    budget -= f.length;
  }
  const typeCheck = { ran: true, checked, findings: bounded };

  // ── 3. bundle ───────────────────────────────────────────────────────────
  // Mount diagnostic, riding a failed bundle's tail: a shim-vs-kernel surprise is
  // otherwise undiagnosable from outside (the report is the only window into the box).
  const mountDiag = (): string => {
    const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
    const mounts = read('/proc/mounts').split('\n').filter((l) => /fuse|workspace/.test(l)).join(' | ') || '(no fuse/workspace mounts)';
    let devFuse = 'absent';
    try { readdirSync('/dev').includes('fuse') && (devFuse = 'present'); } catch { /* unreadable */ }
    let wsEntries = '(unreadable)';
    try { wsEntries = String(readdirSync(workspace).length); } catch { /* unreadable */ }
    return `[mount] /dev/fuse=${devFuse}; ${mounts}; ${workspace} entries=${wsEntries}`;
  };
  let bundle: JobReport['bundle'];
  // ⚠️ `--emptyOutDir=false`, and it is load-bearing under local `wrangler dev`: with FUSE
  // absent, computerd materializes the workspace onto disk and pulls changes back after
  // the exec, and its pull LOSES vite's default empty-then-rewrite of an unchanged dist —
  // the deletion lands, the byte-identical re-creation does not, and the app serves 404
  // behind a clean report (`build-box`, 2026-09-06: `sync.status: complete, applied: 0`
  // with the files on the container's disk). Without the empty, an unchanged file is a
  // no-op both sides and a changed one is a fresh write, which the pull has never missed.
  // The host prunes stale entries against `bundle.files` after arrival (galaxy.ts).
  const vite = spawnSync('vite', ['build', '--emptyOutDir=false'], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Deps are baked at the image ROOT (never the FUSE mount) — resolve vite from
      // /node_modules/.bin; NODE_ENV pinned so rollup never takes a dev path.
      PATH: `/node_modules/.bin:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      NODE_ENV: 'production',
    },
  });
  if (vite.error) {
    bundle = { ran: true, ok: false, tail: tail(`${mountDiag()}\n${String(vite.error)}`) };
  } else if (vite.status === 0) {
    // The digest the host verifies arrival against (build-report.ts) — read back from the
    // disk vite wrote, so it is the bytes the pull is expected to deliver.
    let indexSha256: string | undefined;
    try { indexSha256 = createHash('sha256').update(readFileSync(join(workspace, 'dist', 'index.html'))).digest('hex'); } catch { /* reported as absent */ }
    const files: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), r); else files.push(r);
      }
    };
    try { walk(join(workspace, 'dist'), ''); } catch { /* no dist — reported as absent */ }
    bundle = { ran: true, ok: true, ...(indexSha256 ? { indexSha256 } : {}), files };
  } else {
    bundle = { ran: true, ok: false, tail: tail(`${mountDiag()}\n${vite.stderr ?? ''}\n${vite.stdout ?? ''}`) };
  }

  return { ontology, typeCheck, bundle };
}

// ── entry ─────────────────────────────────────────────────────────────────
const workspace = process.env.WORKSPACE ?? '/workspace';
const report = runJob(workspace, {
  ontologyVersion: process.env.ONTOLOGY_VERSION || undefined,
  wipeOnInstall: process.env.WIPE_ON_INSTALL === '1',
});
console.log(REPORT_MARKER + JSON.stringify(report));
// Exit 0 whether or not steps failed: step outcomes ride the REPORT, and a non-zero
// exit would be read by the host's exec classification as the JOB itself dying
// (container-step infra failure) rather than a step outcome.
process.exit(0);
