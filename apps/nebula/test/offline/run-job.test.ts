/**
 * The build job's one gate, run in plain Node against a real workspace on disk: a failed ontology
 * compile skips the bundle. Node rather than the vitest-plugin lane because the job is container
 * code that reads and writes a real filesystem; `dev-star-follows-the-build` drives the same job
 * in the build box.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from '../../container/compiler/job';
import { ROW_PATH, SKIPPED_FOR_ONTOLOGY } from '../../src/build-report';

function workspaceWith(ontology: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-job-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/ontology.d.ts'), ontology);
  return dir;
}

describe('runJob', () => {
  // Mutation: delete the gate in `runJob`; the bundle then runs (`vite` is absent here, so it
  // reports `ran: true`) and this reds.
  it('skips the bundle when the ontology it compiled failed, and says what to fix', () => {
    const dir = workspaceWith('export interface Deal {\n  title: string\n');
    try {
      const report = runJob(dir, { ontologyVersion: 'v-broken' });
      expect(report.ontology).toMatchObject({ ran: true, ok: false });
      expect(report.bundle).toEqual({ ran: false, why: SKIPPED_FOR_ONTOLOGY });
      expect(existsSync(join(dir, ROW_PATH))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // The positive control: a compile that succeeds writes its row and leaves the bundle to run.
  it('writes the row and runs the bundle when the compile succeeds', () => {
    const dir = workspaceWith('export interface Deal {\n  title: string;\n}\n');
    try {
      const report = runJob(dir, { ontologyVersion: 'v-good' });
      expect(report.ontology).toMatchObject({ ran: true, ok: true });
      expect(existsSync(join(dir, ROW_PATH))).toBe(true);
      expect(report.bundle.ran).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
