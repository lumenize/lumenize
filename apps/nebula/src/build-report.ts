/**
 * The build report's SHAPE — a pure-types-plus-constants LEAF (no imports) shared by
 * the two sides of the container build seam, so they cannot drift:
 *  - the container job (`container/compiler/job.ts`) PRODUCES the middle steps
 *    ({@link JobReport}) and prints them on one stdout line behind
 *    {@link REPORT_MARKER};
 *  - the Worker (`galaxy.ts` / `codegen-loop.ts`) wraps `container` and `publish`
 *    around them into the full {@link BuildReport} the model reads as a tool result.
 */

/** One raw diagnostic line, e.g. `src/App.vue(42,7): error TS2339: Property 'foo'
 *  does not exist on type 'Store'.` — file and line ride the line itself. A plain
 *  string on purpose: it persists inside `CHAT_MESSAGE_TYPES`' codegen record, so
 *  anything structured would buy a schema change (ADR-001/typia) in the same breath. */
export type Finding = string;

/** One step of the container build job. A skipped step says `ran: false` WITH a why —
 *  an absent key would read as "fine". A failing step carries a bounded RAW tail of
 *  the tool's own output, never a summary. */
export type StepResult =
  | { ran: true; ok: true }
  | { ran: true; ok: false; tail: string }
  | { ran: false; why: string };

/** The job's slice of the report — what the container itself can know. */
export interface JobReport {
  /** `ran: false` when the host passed no ontology version (no `.d.ts` change);
   *  `rowPath` names where the compiled row landed in the mount. */
  ontology: StepResult & { rowPath?: string };
  /** ADVISORY — deliberately no `ok`, so nothing can read it as a gate. `checked` is
   *  what tsc actually looked at: a file written, checked and unimplicated is KNOWN
   *  CLEAN. */
  typeCheck: { ran: boolean; checked: string[]; findings: Finding[] };
  /** `!ok` ⇒ there is no `dist`, so nothing to publish (structural, not policy). */
  bundle: StepResult;
}

/**
 * What `build` returns — per-step outcomes, and deliberately NO global `ok`: one
 * boolean would force every step to fold into it, and folding in the type check means
 * deciding whether a finding is fatal, which is the judgement this design hands to
 * the model.
 *
 * `container` is the job/exec itself (`!ok` ⇒ infra — but a tail naming the build
 * timeout means retrying unchanged will time out again); `publish` always carries a
 * why, so a preview that did not refresh is never silent.
 */
export type BuildReport = JobReport & {
  container: StepResult;
  publish: { done: boolean; why: string };
};

/** True iff a step ran and failed (a skipped step is not a failure). */
export function stepFailed(s: StepResult): boolean {
  return s.ran && s.ok === false;
}

/** Where the compiled `OntologyVersionRow` lands in the mount, workspace-relative.
 *  Outside `dist/` on purpose — vite empties `dist/` at build, which runs after the
 *  ontology step. Never committed: git tracks only what `git.add` is handed. */
export const ROW_PATH = '.nebula/ontology-row.json';

/**
 * The HOST-side root of the served tree. The container's FUSE mount serves the VFS's
 * `/workspace` SUBTREE, not the VFS root — computerd mirrors the mount at the SAME
 * absolute path inside the VFS, so a host write at `/src/App.vue` syncs into
 * computerd's store but is never served, which presents as a mount that is up and
 * empty while the exec bracket reports entries pushed (bisected 2026-08-29,
 * `experiments/fuse-bisect`: the same seed at `/workspace/...` serves immediately).
 * Every host-side `ws.fs` path and every `ws.git` op's `dir` goes through this;
 * container-side paths are real `/workspace/...` paths and line up by construction.
 */
export const WS_ROOT = '/workspace';

/** A workspace-relative path (`src/App.vue`, {@link ROW_PATH}) → its host-side VFS
 *  path under {@link WS_ROOT}. */
export function wsPath(rel: string): string {
  return `${WS_ROOT}/${rel.replace(/^\/+/, '')}`;
}

/** The report's stdout marker — the one line the host parses out of the job's
 *  output; everything else on stdio is human/debug noise. */
export const REPORT_MARKER = '__NEBULA_BUILD_REPORT__';
