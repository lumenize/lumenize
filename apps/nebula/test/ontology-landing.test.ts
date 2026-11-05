/**
 * The decisions behind "the `.dev` Star runs the last build the model previewed" (ADR-024), as
 * tables. `decideLanding` says whether a build lands on `.dev`, the model's preview call included;
 * `heldBackLine` says what a turn's reply adds when its last build did not; `isDevStarCall` says
 * which Star asked, and so whether the Galaxy answers with the `.dev` row or with the published one.
 *
 * In the vitest-plugin lane rather than `/live`: all three are pure functions of their arguments, so
 * no running system adds anything a table does not already pin. `dev-star-follows-the-build`
 * drives the landing through a real build and a real Star.
 */
import { describe, it, expect } from 'vitest';
import { completedTurnFallback, decideLanding, heldBackLine, isDevStarCall } from '../src/galaxy';
import { SKIPPED_FOR_ONTOLOGY } from '../src/build-report';
import type { BuildReport } from '../src/build-report';

const HELD_FOR_FINDINGS = 'type findings — held back, so .dev still serves the last previewed build; build again with { "preview": true } to land it anyway';
const NOT_ARRIVED = 'the built dist did not arrive back from the container (sync pull incomplete) — build again';
const report = (over: Partial<BuildReport> = {}): BuildReport => ({
  container: { ran: true, ok: true },
  ontology: { ran: true, ok: true },
  typeCheck: { ran: true, checked: [], findings: [] },
  bundle: { ran: true, ok: true, indexSha256: 'abc' },
  preview: { refreshed: false, why: 'not decided at the build layer' },
  ...over,
});

describe('decideLanding', () => {
  const findings = ['src/App.vue(1,1): error TS2322: x'];
  const withFindings = report({ typeCheck: { ran: true, checked: ['src/App.vue'], findings } });
  // Mutations: drop the bundle, digest, arrival or compile conjunct, the `{ preview: false }` arm,
  // or the findings arm; each reds its own rows, on `refreshed` as well as on `why`.
  it.each([
    { name: 'a failed compile, whose bundle the job skipped',
      r: report({ ontology: { ran: true, ok: false, tail: 'x' }, bundle: { ran: false, why: SKIPPED_FOR_ONTOLOGY } }),
      arrived: false, version: 'v', preview: undefined, refreshed: false,
      why: `bundle did not run (${SKIPPED_FOR_ONTOLOGY}) — there is no new dist` },
    { name: 'a compile reported failed beside a bundle that ran',
      r: report({ ontology: { ran: true, ok: false, tail: 'x' } }),
      arrived: true, version: 'v', preview: undefined, refreshed: false, why: 'the ontology compile did not succeed' },
    { name: 'a compile that never ran, though the host passed a version',
      r: report({ ontology: { ran: false, why: 'the build job did not run' } }),
      arrived: true, version: 'v', preview: undefined, refreshed: false, why: 'the ontology compile did not succeed' },
    { name: 'a failed bundle, even on the model\'s { preview: true }',
      r: report({ bundle: { ran: true, ok: false, tail: 'rolldown died' } }),
      arrived: true, version: 'v', preview: true, refreshed: false, why: 'bundle failed — there is no dist to serve' },
    { name: 'a bundle that never ran, even on { preview: true }',
      r: report({ bundle: { ran: false, why: 'the build job did not run' } }),
      arrived: false, version: undefined, preview: true, refreshed: false,
      why: 'bundle did not run (the build job did not run) — there is no new dist' },
    { name: 'a successful bundle with no index.html digest',
      r: report({ bundle: { ran: true, ok: true } }),
      arrived: true, version: undefined, preview: true, refreshed: false,
      why: 'the bundle reported no digest of its index.html, so its arrival cannot be checked — build again' },
    { name: 'a bundle that did not arrive',
      r: report(), arrived: false, version: 'v', preview: undefined, refreshed: false, why: NOT_ARRIVED },
    { name: 'a bundle with findings that did not arrive, even on { preview: true }',
      r: withFindings, arrived: false, version: 'v', preview: true, refreshed: false, why: NOT_ARRIVED },
    { name: 'a clean build that arrived, with its ontology',
      r: report(), arrived: true, version: 'v', preview: undefined, refreshed: true, why: 'clean build, landed' },
    { name: 'a clean build that arrived, the ontology file unchanged',
      r: report({ ontology: { ran: false, why: 'no ontology change (host passed no version)' } }),
      arrived: true, version: undefined, preview: undefined, refreshed: true, why: 'clean build, landed' },
    { name: 'a clean build the model held back with { preview: false }',
      r: report(), arrived: true, version: 'v', preview: false, refreshed: false,
      why: 'held back on the model\'s { "preview": false }, so .dev still serves the last previewed build' },
    { name: 'a build with type findings, by default',
      r: withFindings, arrived: true, version: 'v', preview: undefined, refreshed: false, why: HELD_FOR_FINDINGS },
    { name: 'a build with type findings, on the model\'s { preview: true }',
      r: withFindings, arrived: true, version: 'v', preview: true, refreshed: true, why: 'landed on the model\'s { "preview": true }' },
    { name: 'a build with type findings, on { preview: false }',
      r: withFindings, arrived: true, version: 'v', preview: false, refreshed: false,
      why: 'held back on the model\'s { "preview": false }, so .dev still serves the last previewed build' },
  ])('$name', ({ r, arrived, version, preview, refreshed, why }) => {
    expect(decideLanding(r, { arrived, ontologyVersion: version, preview })).toEqual({ refreshed, why });
  });
});

describe('heldBackLine', () => {
  const landed = { refreshed: true, why: 'clean build, landed' };
  // Mutations: key the predicate on `typeCheck.findings` alone and the `{ preview: false }` row reds;
  // drop the container arm and its row reads as "did not bundle"; key it on nothing and the landed
  // rows red.
  it.each([
    { name: 'no build this turn', r: undefined, line: undefined },
    { name: 'a build that landed', r: report({ preview: landed }), line: undefined },
    { name: 'a build with findings that landed on { preview: true }',
      r: report({ typeCheck: { ran: true, checked: [], findings: ['x'] }, preview: { refreshed: true, why: 'landed on override' } }),
      line: undefined },
    { name: 'a build held back for its type findings',
      r: report({ typeCheck: { ran: true, checked: [], findings: ['x'] }, preview: { refreshed: false, why: HELD_FOR_FINDINGS } }),
      line: 'The preview was not updated: the last build was held back for its type findings.' },
    { name: 'a build with findings refused for another reason names that reason, not the findings',
      r: report({ typeCheck: { ran: true, checked: [], findings: ['x'] }, preview: { refreshed: false, why: NOT_ARRIVED } }),
      line: `The preview was not updated: the last build did not land (${NOT_ARRIVED}).` },
    { name: 'a clean build held back on { preview: false }',
      r: report({ preview: { refreshed: false, why: 'held back on the model\'s { "preview": false }' } }),
      line: 'The preview was not updated: the last build did not land (held back on the model\'s { "preview": false }).' },
    { name: 'a bundle that failed',
      r: report({ bundle: { ran: true, ok: false, tail: 'x' }, preview: { refreshed: false, why: 'bundle failed' } }),
      line: 'The preview was not updated: the last build did not bundle.' },
    { name: 'a build the box could not run',
      r: report({ container: { ran: true, ok: false, tail: 'x' }, bundle: { ran: false, why: 'the build job did not run' },
        preview: { refreshed: false, why: 'bundle did not run' } }),
      line: 'The preview was not updated: the build box could not run the last build.' },
    { name: 'a refused row',
      r: report({ preview: { refreshed: false, why: 'the compiled types do not match the version the build was asked for — build again' } }),
      line: 'The preview was not updated: the last build did not land (the compiled types do not match the version the build was asked for — build again).' },
  ])('$name', ({ r, line }) => {
    expect(heldBackLine(r)).toBe(line);
  });
});

describe('completedTurnFallback', () => {
  // What a completed turn says when the model wrote nothing. Mutations: read `appliedPaths` before
  // the landing and the preview-only row reds; drop the held-back arm and its row gains a sentence
  // beside the Galaxy's own line.
  it.each([
    { name: 'a build that landed, with files written', applied: 2, r: report({ preview: { refreshed: true, why: 'clean build, landed' } }), text: 'Updated the preview.' },
    { name: 'a build that landed with no file written, as a preview-it-anyway turn',
      applied: 0, r: report({ preview: { refreshed: true, why: "landed on the model's { \"preview\": true }" } }), text: 'Updated the preview.' },
    { name: 'a held-back build, whose line says why', applied: 1, r: report({ preview: { refreshed: false, why: HELD_FOR_FINDINGS } }), text: '' },
    { name: 'files written and nothing built', applied: 1, r: undefined, text: 'Saved the changes; nothing was built, so the preview is unchanged.' },
    { name: 'nothing written and nothing built', applied: 0, r: undefined, text: 'Done — no changes.' },
  ])('$name', ({ applied, r, text }) => {
    expect(completedTurnFallback(applied, r)).toBe(text);
  });
});

describe('isDevStarCall', () => {
  const star = (instanceName: string) => ({ type: 'LumenizeDO', bindingName: 'STAR', instanceName });
  const client = { type: 'LumenizeClient', bindingName: 'STAR', instanceName: 'acme.crm.dev/alice.x' };
  // Mutations: a prefix match (`startsWith`) reds the `devops` row; reading `callChain[0]` reds the
  // two rows whose origin and last hop differ; dropping the binding check reds the GALAXY row.
  it.each([
    { name: 'the Galaxy\'s own .dev Star', chain: [star('acme.crm.dev')], dev: true },
    { name: 'its .dev Star, asking for a Client\'s op', chain: [client, star('acme.crm.dev')], dev: true },
    { name: 'a Star founded as acme.crm.devops', chain: [star('acme.crm.devops')], dev: false },
    { name: 'a Client at acme.crm.dev/alice.x', chain: [client], dev: false },
    { name: 'another Galaxy\'s .dev Star', chain: [star('acme.other.dev')], dev: false },
    { name: 'a tenant Star', chain: [star('acme.crm.tenant1')], dev: false },
    { name: 'a chain whose last hop is a Client', chain: [star('acme.crm.dev'), client], dev: false },
    { name: 'the .dev name on another binding', chain: [{ ...star('acme.crm.dev'), bindingName: 'GALAXY' }], dev: false },
    { name: 'an empty chain', chain: [], dev: false },
    { name: 'no call context', chain: undefined, dev: false },
  ])('$name', ({ chain, dev }) => {
    expect(isDevStarCall(chain, 'acme.crm')).toBe(dev);
  });
});
