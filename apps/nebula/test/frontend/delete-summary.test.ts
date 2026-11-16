/**
 * The delete confirmation's sentence, asserted as a function because it is one: a deletion plan in,
 * words out, with no running system between them. Whether the confirmation shows it is the
 * `/live` scenarios' to see (`studio-app-settings`, `delete-from-its-own-page`).
 *
 * The sentence is the only restraint a delete has (ADR-015), so what it counts matters: the apps
 * and tenants beneath the target, by the names the UI gives them, and never an app's own
 * workspace, which would make a one-app account read as holding two things.
 */
import { describe, it, expect } from 'vitest';
import { deletionSentence, type AffectedScope } from '../../../nebula-studio-ui/src/delete-summary';

const universe = (id: string): AffectedScope => ({ instanceName: id, tier: 'universe', isDev: false });
const galaxy = (id: string): AffectedScope => ({ instanceName: id, tier: 'galaxy', isDev: false });
const star = (id: string): AffectedScope => ({ instanceName: id, tier: 'star', isDev: id.endsWith('.dev') });

describe('deletionSentence', () => {
  it('names an account\'s apps and their tenants by kind, and leaves each app\'s workspace out', () => {
    const affected = [
      star('acme.crm.dev'), star('acme.crm.t1'), star('acme.crm.t2'), galaxy('acme.crm'),
      star('acme.hr.dev'), star('acme.hr.t1'), galaxy('acme.hr'), universe('acme'),
    ];
    expect(deletionSentence('this account', 'acme', affected))
      .toBe('This permanently deletes this account, its 2 apps and their 3 tenants, and everything in them.');
  });

  it('says a single app\'s tenants are its own', () => {
    const affected = [star('acme.crm.dev'), star('acme.crm.t1'), galaxy('acme.crm'), universe('acme')];
    expect(deletionSentence('this account', 'acme', affected))
      .toBe('This permanently deletes this account, its 1 app and its 1 tenant, and everything in them.');
  });

  it('names an account\'s apps alone when none has a tenant', () => {
    const affected = [star('acme.crm.dev'), galaxy('acme.crm'), star('acme.hr.dev'), galaxy('acme.hr'), universe('acme')];
    expect(deletionSentence('this account', 'acme', affected))
      .toBe('This permanently deletes this account and its 2 apps, and everything in them.');
  });

  it('names an app\'s tenants, and does not count the app itself', () => {
    const affected = [star('acme.crm.dev'), star('acme.crm.t1'), star('acme.crm.t2'), galaxy('acme.crm')];
    expect(deletionSentence('this app', 'acme.crm', affected))
      .toBe('This permanently deletes this app and its 2 tenants, and everything in them.');
  });

  it('counts nothing for an app that has only its workspace', () => {
    expect(deletionSentence('this app', 'acme.crm', [star('acme.crm.dev'), galaxy('acme.crm')]))
      .toBe('This permanently deletes this app and everything in it.');
  });

  it('counts nothing beneath a tenant', () => {
    expect(deletionSentence('the tenant t1', 'acme.crm.t1', [star('acme.crm.t1')]))
      .toBe('This permanently deletes the tenant t1 and everything in it.');
  });
});
