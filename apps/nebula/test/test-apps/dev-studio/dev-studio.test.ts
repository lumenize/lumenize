/**
 * DevStudio node (Phase 3.5b) — the source-of-truth + compile-and-apply mechanism.
 *
 * Driven via `__executeOperation` envelopes (no Gateway/JWT) carrying an admin claim
 * at the `{u}.{g}.dev` scope, so the real receive seam runs (onBeforeCall scope guard
 * + requireAdmin). Proves:
 *  - **source-of-truth round-trip** (the "testable now" half of success criterion #3):
 *    `writeSource` commits to the shell Workspace (distinct git oids), `readSource`
 *    returns the latest, `getSourceTree` returns the tracked tree + HEAD;
 *  - **compile-and-apply** (replaces `DevStar.deployToDev`'s Galaxy pull, Decision 9):
 *    `applyOntology` compiles the ontology `.d.ts` and installs it on the `.dev` Star;
 *  - the version is **content-addressed** (the Worker Loader `bundleId` cache guard);
 *  - the command surface is **admin-gated**.
 *
 * The container-push (`ensureUp`/`syncToDevContainer`) is deploy-gated `it.skip`
 * (DEV_CONTAINER `extends Container` can't construct under pool-workers).
 *
 * @see tasks/nebula-studio.md § DevStudio node
 * @see experiments/interim-dev-loop/RESULTS.md — the proven shell+git mechanism
 */
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { preprocess, postprocess } from '@lumenize/structured-clone';

const ONTOLOGY_PATH = 'src/ontology.d.ts';
const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;
const OID_RE = /^[0-9a-f]{40}$/;

// A DevStudio sandbox is addressed by a parseId-valid {u}.{g}.dev star-tier id.
const uniqueDevScope = () => `${crypto.randomUUID()}.app.dev`;

function envelope(
  bindingName: string,
  instanceName: string,
  method: string,
  args: unknown[] = [],
  claims: Record<string, unknown> = { aud: instanceName, access: { admin: true } },
) {
  const chain = [
    { type: 'get', key: method },
    { type: 'apply', args },
  ];
  return {
    version: 1,
    chain: preprocess(chain),
    callContext: { callChain: [], state: {}, originAuth: { sub: 'admin', claims } } as any,
    metadata: { callee: { type: 'LumenizeDO', bindingName, instanceName } },
  };
}

const unwrap = (r: any) => {
  if (r?.$error) throw postprocess(r.$error);
  return r?.$result;
};

async function callStudio(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).DEV_STUDIO.getByName(instance);
  return unwrap(await stub.__executeOperation(envelope('DEV_STUDIO', instance, method, args)));
}
async function callDevStar(instance: string, method: string, args: unknown[] = []) {
  const stub = (env as any).DEV_STAR.getByName(instance);
  return unwrap(await stub.__executeOperation(envelope('DEV_STAR', instance, method, args)));
}

describe('DevStudio source-of-truth (shell Workspace + isomorphic-git)', () => {
  it('writeSource commits distinct oids; readSource returns the latest; getSourceTree tracks the tree + HEAD', async () => {
    const dev = uniqueDevScope();
    const e1 = await callStudio(dev, 'writeSource', ['src/App.vue', '<template>a</template>']);
    expect(e1.oid).toMatch(OID_RE);
    expect(e1.path).toBe('src/App.vue');

    // A second edit is a DISTINCT commit (real git history in the DO's SQL).
    const e2 = await callStudio(dev, 'writeSource', ['src/App.vue', '<template>b</template>']);
    expect(e2.oid).toMatch(OID_RE);
    expect(e2.oid).not.toBe(e1.oid);

    // readSource returns the LATEST content.
    expect(await callStudio(dev, 'readSource', ['src/App.vue'])).toBe('<template>b</template>');

    // getSourceTree = tracked files + HEAD (what a cold DevContainer is re-pushed).
    await callStudio(dev, 'writeSource', ['ontology.d.ts', TODO_V1]);
    const tree = await callStudio(dev, 'getSourceTree');
    expect(tree.head).toBe((await callStudio(dev, 'getSourceTree')).head); // stable HEAD
    expect(tree.head).toMatch(OID_RE);
    const appFile = tree.files.find((f: any) => f.path === 'src/App.vue');
    expect(appFile?.content).toBe('<template>b</template>');
    expect(tree.files.some((f: any) => f.path === 'ontology.d.ts')).toBe(true);
  });
});

describe('DevStudio compile-and-apply to the .dev Star (replaces deployToDev)', () => {
  it('applyOntology compiles the ontology .d.ts and installs the version on the .dev Star', async () => {
    const dev = uniqueDevScope();
    await callStudio(dev, 'writeSource', [ONTOLOGY_PATH, TODO_V1]);

    const { version } = await callStudio(dev, 'applyOntology', [{}]);
    expect(version).toMatch(OID_RE);

    // Installed on the .dev Star (cross-DO mesh callRaw → setOntology → #installState).
    // Capable-of-failing: if applyOntology didn't reach the Star, the index is empty.
    const index = await callDevStar(dev, 'inspectOntologyIndex');
    expect(index).toContain(version);
  });

  it('the version is CONTENT-ADDRESSED — changing the ontology yields a new version (Worker Loader cache guard)', async () => {
    const dev = uniqueDevScope();
    await callStudio(dev, 'writeSource', [ONTOLOGY_PATH, TODO_V1]);
    const r1 = await callStudio(dev, 'applyOntology', [{}]);

    // Edit the ontology → a DIFFERENT compiled version (git.hashBlob of the source).
    // A constant label (e.g. 'dev') would silently reuse the cached validator bundle.
    await callStudio(dev, 'writeSource', [ONTOLOGY_PATH, TODO_V2]);
    const r2 = await callStudio(dev, 'applyOntology', [{}]);
    expect(r2.version).not.toBe(r1.version);

    const index = await callDevStar(dev, 'inspectOntologyIndex');
    expect(index).toContain(r2.version);
  });

  it('applyOntology({ wipe: true }) wipes the .dev Star BEFORE installing (Flow 1b wipe path)', async () => {
    const dev = uniqueDevScope();
    // Install an initial ontology (no wipe) so the .dev Star already carries state.
    await callStudio(dev, 'writeSource', [ONTOLOGY_PATH, TODO_V1]);
    const { version: vA } = await callStudio(dev, 'applyOntology', [{}]);
    expect(await callDevStar(dev, 'inspectOntologyIndex')).toContain(vA);

    // Change the ontology + apply WITH wipe. resetDevData (deleteAll) must run BEFORE
    // setOntology, so the prior version is gone and only the new one remains.
    await callStudio(dev, 'writeSource', [ONTOLOGY_PATH, TODO_V2]);
    const { version: vB } = await callStudio(dev, 'applyOntology', [{ wipe: true }]);
    expect(vB).not.toBe(vA);

    const index = await callDevStar(dev, 'inspectOntologyIndex');
    // Capable-of-failing on the WIPE: if resetDevData were a no-op (or ran AFTER
    // setOntology), setOntology would APPEND → index = [vA, vB]. The wipe-before-
    // install guarantee means the old version is gone (the new validator lands on a
    // clean Star). The source (ontology .d.ts) survives — it lives in DevStudio, not
    // the wiped Star.
    expect(index).toContain(vB);
    expect(index).not.toContain(vA);
  });
});

describe('DevStudio command surface is admin-gated', () => {
  it('a non-admin (valid scope, no admin claim) is rejected — writes nothing', async () => {
    const dev = uniqueDevScope();
    const stub = (env as any).DEV_STUDIO.getByName(dev);
    const r = await stub.__executeOperation(
      envelope('DEV_STUDIO', dev, 'writeSource', ['src/App.vue', 'x'], { aud: dev }),
    );
    expect(postprocess(r.$error).message).toContain('Admin access required');
    // Capable-of-failing: nothing was committed — getSourceTree (as admin) is empty.
    const tree = await callStudio(dev, 'getSourceTree');
    expect(tree.files.length).toBe(0);
    expect(tree.head).toBeNull();
  });
});

describe('DevStudio container push (deploy-gated)', () => {
  it.skip('ensureUp/syncToDevContainer push source to DevContainer (needs a deployed Worker + live container)', () => {
    // DevContainer `extends Container` can't construct under vitest-pool-workers, so
    // the applyChanges push round-trip is deploy-gated. Mechanism proven in
    // experiments/interim-dev-loop (DevStudio→container source transport over mesh).
    // Revive against the first full apps/nebula Worker deploy.
  });
});
