/**
 * The two decisions behind "the `.dev` Star runs the last landed build's row" (ADR-024), as
 * tables. `decideLanding` says whether a build's page and types move; `isDevStarCall` says which
 * Star asked, and so whether the Galaxy answers with that row or with the published one.
 *
 * In the vitest-plugin lane rather than `/live`: both are pure functions of their arguments, so
 * no running system adds anything a table does not already pin. `dev-star-follows-the-build`
 * drives both through a real build and a real Star.
 */
import { describe, it, expect } from 'vitest';
import { decideLanding, isDevStarCall } from '../src/galaxy';
import { SKIPPED_FOR_ONTOLOGY } from '../src/build-report';
import type { BuildReport } from '../src/build-report';

const report = (over: Partial<BuildReport> = {}): BuildReport => ({
  container: { ran: true, ok: true },
  ontology: { ran: true, ok: true },
  typeCheck: { ran: true, checked: [], findings: [] },
  bundle: { ran: true, ok: true, indexSha256: 'abc' },
  preview: { refreshed: false, why: 'not decided at the build layer' },
  ...over,
});

describe('decideLanding', () => {
  // Mutations: drop the bundle conjunct, the arrival conjunct, or the compile conjunct; each reds
  // its own rows, on `lands` as well as on `why`.
  it.each([
    { name: 'a failed compile, whose bundle the job skipped',
      r: report({ ontology: { ran: true, ok: false, tail: 'x' }, bundle: { ran: false, why: SKIPPED_FOR_ONTOLOGY } }),
      arrived: false, version: 'v', lands: false, why: 'the bundle did not succeed' },
    { name: 'a compile reported failed beside a bundle that ran',
      r: report({ ontology: { ran: true, ok: false, tail: 'x' } }),
      arrived: true, version: 'v', lands: false, why: 'the ontology compile did not succeed' },
    { name: 'a compile that never ran, though the host passed a version',
      r: report({ ontology: { ran: false, why: 'the build job did not run' } }),
      arrived: true, version: 'v', lands: false, why: 'the ontology compile did not succeed' },
    { name: 'a failed bundle',
      r: report({ bundle: { ran: true, ok: false, tail: 'rolldown died' } }),
      arrived: false, version: 'v', lands: false, why: 'the bundle did not succeed' },
    // Its one caller never passes this pairing; the row pins that the bundle check decides alone.
    { name: 'a failed bundle counted as arrived',
      r: report({ bundle: { ran: true, ok: false, tail: 'rolldown died' } }),
      arrived: true, version: 'v', lands: false, why: 'the bundle did not succeed' },
    { name: 'a bundle that did not arrive',
      r: report(), arrived: false, version: 'v', lands: false, why: 'the built dist did not arrive' },
    { name: 'a bundle that arrived, with its ontology',
      r: report(), arrived: true, version: 'v', lands: true, why: 'landed with its ontology' },
    { name: 'a bundle that arrived, the file unchanged',
      r: report({ ontology: { ran: false, why: 'no ontology change (host passed no version)' } }),
      arrived: true, version: undefined, lands: true, why: 'landed, ontology unchanged' },
  ])('$name', ({ r, arrived, version, lands, why }) => {
    expect(decideLanding(r, { arrived, ontologyVersion: version })).toEqual({ lands, why });
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
