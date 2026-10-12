/**
 * The build job, faked for the vitest-plugin lane, where no container exists. Both test Galaxies'
 * `build()` seams run this, so the layer above them — the landing, the preview decision and the
 * announcement — runs unchanged. It mirrors `container/compiler/job.ts` where the Galaxy reads the
 * result: the row lands at ROW_PATH, a failed compile skips the bundle, and a bundle that ran writes
 * `dist/index.html` and reports its digest, which the landing's arrival check reads.
 *
 * A test Worker never deploys, so compiling here is licensed (`ontology-compile.ts`'s header).
 */
import type { Workspace } from '@cloudflare/computer';
import { ROW_PATH, SKIPPED_FOR_ONTOLOGY, wsPath } from '../../src/build-report';
import type { BuildReport } from '../../src/build-report';
import { compileOntologyVersion } from '../../src/ontology-compile';

/** What a test can make the next builds do wrong. */
export interface BuildFaults {
  /** The bundle runs and fails, as a `vite build` error would. */
  failBundle?: boolean;
  /** Compile these types under the version the host passed, as a file a chat write changed
   *  between the host's hash and the job's compile would. */
  compileTypes?: string;
  /** Report the compile as succeeded without writing its row, as a lost pull would leave the
   *  mount: ROW_PATH keeps whatever an earlier build wrote there. */
  loseRow?: boolean;
  /** Fields laid over the row file after the compile, as the build's own `vite.config.ts` could:
   *  the types still hash to the version, while the label and extra keys say otherwise. */
  dressRow?: Record<string, unknown>;
  /** Called once the compile has written its row, so a test can act while this build runs. */
  onCompiled?: () => void;
  /** Then wait this long before the bundle, so a second build can be asked for meanwhile. */
  holdMs?: number;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fakeBuildJob(
  fs: Workspace['fs'],
  opts: { ontology?: { version: string } },
  faults: BuildFaults = {},
): Promise<BuildReport> {
  let ontology: BuildReport['ontology'] = { ran: false, why: 'no ontology change (host passed no version)' };
  if (opts.ontology) {
    try {
      const types = faults.compileTypes ?? await fs.readFile(wsPath('src/ontology.d.ts'), 'utf8');
      const row = compileOntologyVersion({ version: opts.ontology.version, types });
      if (!faults.loseRow) {
        await fs.mkdir(wsPath('.nebula'), { recursive: true });
        await fs.writeFile(wsPath(ROW_PATH), JSON.stringify({ ...row, ...faults.dressRow }));
      }
      ontology = { ran: true, ok: true, rowPath: ROW_PATH };
    } catch (e) {
      ontology = { ran: true, ok: false, tail: e instanceof Error ? e.message : String(e) };
    }
  }
  faults.onCompiled?.();
  if (faults.holdMs) await new Promise((r) => setTimeout(r, faults.holdMs));
  const typeCheck = { ran: true, checked: ['src/App.vue'], findings: [] };
  let bundle: BuildReport['bundle'];
  if (ontology.ran && ontology.ok === false) {
    bundle = { ran: false, why: SKIPPED_FOR_ONTOLOGY };
  } else if (faults.failBundle) {
    bundle = { ran: true, ok: false, tail: 'injected bundle failure (test)' };
  } else {
    // The page changes with the app's source, as a real `vite build`'s output does.
    let app = '';
    try { app = await fs.readFile(wsPath('src/App.vue'), 'utf8'); } catch { /* no App.vue yet */ }
    const html = `<!doctype html><html><head></head><body>${await sha256Hex(app)}</body></html>`;
    await fs.mkdir(wsPath('dist'), { recursive: true });
    await fs.writeFile(wsPath('dist/index.html'), html);
    bundle = { ran: true, ok: true, indexSha256: await sha256Hex(html), files: ['index.html'] };
  }
  return {
    container: { ran: true, ok: true },
    ontology,
    typeCheck,
    bundle,
    preview: { refreshed: false, why: 'not decided at the build layer' },
  };
}
