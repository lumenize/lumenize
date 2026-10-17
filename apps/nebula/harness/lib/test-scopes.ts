/**
 * What the deployed test venue names the scopes it creates, and which of its certificate packs and
 * accounts a run sweeps.
 *
 * Every galaxy on `lumenize-test.dev` orders a certificate pack, and a zone holds a bounded number
 * of packs. So the venue names what it creates `test-{MMDD}-{random}`, such as `test-0916-k3x9q2`,
 * and at startup the harness deletes the packs of `test-` hosts older than a few days. Sweeping by
 * age rather than by last run keeps a concurrent run's packs alive.
 *
 * Accounts are swept too, by the same label. Home lists at most fifty of them, and the superuser
 * scenarios assert that a fresh account appears there, so leftovers from earlier runs crowd it out
 * (both went red on 2026-10-04 with fifty listed). A run deletes most of what it claimed, as each
 * account's owner (`lib/shared-app.ts`), but leaves its shared app, every claim nobody accepted, and
 * whatever a crashed run never reached — ten accounts after one deployed sweep on 2026-10-05. The
 * account sweep deletes those as the deployed superuser once they pass its window.
 * `test-` is also the marker the soft-delete reaper reserves (`tasks/backlog.md` § *Other Nebula
 * backlog*).
 *
 * Pure, so the unit lane checks the predicates and the sweeps' loops without a zone; `drive.ts`
 * runs them against the target.
 */

/** How old a `test-` pack must be before a run deletes it. A run lasts minutes, so three days
 *  leaves every concurrent run's packs alone. */
export const SWEEP_WINDOW_DAYS = 3;

/**
 * How old a `test-` account must be before a run deletes it. A label carries only its UTC day, so
 * one day would also take a run that started before midnight and is still going; two leaves every
 * run of the last day alone, and keeps what accumulates to two days of leftovers.
 */
export const ACCOUNT_SWEEP_WINDOW_DAYS = 2;

/** A host label is 30 characters at most (`isValidSlug`). */
const MAX_SLUG_LENGTH = 30;
const TEST_LABEL = /^test-(\d{2})(\d{2})-/;
const DAY_MS = 86_400_000;

/**
 * A slug for a scope the venue creates: `test-{MMDD}-{label}{random}`, the date in UTC. `label` names
 * what made it, for a reader of the zone's packs, and may be empty.
 */
export function testSlug(label = '', now = new Date()): string {
  const mmdd = `${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  const slug = `test-${mmdd}-${label}${random}`;
  if (slug.length > MAX_SLUG_LENGTH || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`testSlug: "${slug}" is not a legal host label; shorten the label "${label}"`);
  }
  return slug;
}

/**
 * The UTC day a `test-{MMDD}-…` label was minted, or `undefined` for any other label. The label has
 * no year, so it is the latest such day not after `now`: a December label read in January is last
 * year's.
 */
export function testLabelDate(label: string, now: Date): Date | undefined {
  const m = TEST_LABEL.exec(label);
  if (!m) return undefined;
  const month = Number(m[1]) - 1;
  const day = Number(m[2]);
  const thisYear = new Date(Date.UTC(now.getUTCFullYear(), month, day));
  if (thisYear.getUTCMonth() !== month || thisYear.getUTCDate() !== day) return undefined; // no such day
  if (thisYear.getTime() <= now.getTime()) return thisYear;
  return new Date(Date.UTC(now.getUTCFullYear() - 1, month, day));
}

/**
 * Whether a pack is a test run's and older than the window. Only hosts inside `zoneHost` count, so
 * a token pointed at the wrong zone deletes nothing, and the pack's age is its NEWEST `test-` label:
 * a galaxy minted today under a universe minted last week is today's. A pack naming no `test-` label,
 * such as the zone's own Universal pack, is never stale.
 */
export function isStaleTestPack(
  hosts: readonly string[], zoneHost: string, now: Date, windowDays = SWEEP_WINDOW_DAYS,
): boolean {
  let newest: Date | undefined;
  for (const raw of hosts) {
    const host = raw.startsWith('*.') ? raw.slice(2) : raw;
    if (!host.endsWith(`.${zoneHost}`)) continue;
    for (const label of host.slice(0, -(zoneHost.length + 1)).split('.')) {
      const minted = testLabelDate(label, now);
      if (minted && (!newest || minted > newest)) newest = minted;
    }
  }
  return newest !== undefined && now.getTime() - newest.getTime() > windowDays * DAY_MS;
}

/** What the sweep asks of the certificate-packs API — `cloudflareCertificateApi`'s list and delete. */
export interface PackSweepApi {
  list(): Promise<Array<{ id: string; hosts: string[] }>>;
  delete(packId: string): Promise<void>;
}

/**
 * Delete every stale test pack in the zone, returning their ids. A failed delete is reported and
 * the sweep goes on: the next run's sweep retries it.
 */
export async function sweepStaleTestPacks(
  api: PackSweepApi, zoneHost: string, now = new Date(), report: (line: string) => void = () => {},
): Promise<string[]> {
  const deleted: string[] = [];
  for (const pack of await api.list()) {
    if (!isStaleTestPack(pack.hosts, zoneHost, now)) continue;
    try {
      await api.delete(pack.id);
      deleted.push(pack.id);
      report(`deleted stale test pack ${pack.id} (${pack.hosts.join(', ')})`);
    } catch (e) {
      report(`could not delete stale test pack ${pack.id}: ${(e as Error).message}`);
    }
  }
  return deleted;
}

/**
 * Whether a universe is a test run's account older than the window: its own name is a `test-` label
 * minted more than `windowDays` ago. Any other name, such as a person's, is never stale.
 */
export function isStaleTestAccount(universe: string, now: Date, windowDays = ACCOUNT_SWEEP_WINDOW_DAYS): boolean {
  const minted = testLabelDate(universe, now);
  return minted !== undefined && now.getTime() - minted.getTime() > windowDays * DAY_MS;
}

/** What the account sweep asks of the target — `superuserAccounts`'s list and delete. */
export interface AccountSweepApi {
  /** The universes on the target, as Home lists them: alphabetically, at most a budget's worth. */
  list(): Promise<string[]>;
  delete(universe: string): Promise<void>;
}

/**
 * Delete every universe `isStale` selects, returning their names. Home lists at most a budget's
 * worth, so the sweep lists again after each pass and stops when one finds nothing it has not tried;
 * the oldest labels sort first, so each pass uncovers the next. A failed delete is reported and not
 * retried this run, and the sweep goes on.
 */
export async function sweepStaleTestAccounts(
  api: AccountSweepApi, isStale: (universe: string) => boolean, report: (line: string) => void = () => {},
): Promise<string[]> {
  const deleted: string[] = [];
  const tried = new Set<string>();
  for (;;) {
    const batch = (await api.list()).filter((universe) => isStale(universe) && !tried.has(universe));
    if (batch.length === 0) return deleted;
    for (const universe of batch) {
      tried.add(universe);
      try {
        await api.delete(universe);
        deleted.push(universe);
        report(`deleted stale test account ${universe}`);
      } catch (e) {
        report(`could not delete stale test account ${universe}: ${(e as Error).message}`);
      }
    }
  }
}
