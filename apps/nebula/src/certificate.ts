/**
 * A galaxy's certificate pack — the decisions as pure functions, and the one client of Cloudflare's
 * certificate-packs API.
 *
 * Creating a galaxy orders one advanced pack naming the zone apex, the galaxy's own host and its
 * wildcard: `lumenize.dev`, `crm.acme.lumenize.dev` and `*.crm.acme.lumenize.dev` cover Studio, every
 * Star and every persona of `acme.crm`, and a universe orders none, since Universal SSL covers its one
 * label. The Galaxy's Durable Object drives the pack from its own alarm (`galaxy.ts`), and the
 * functions here decide each step from what it has stored and what the API last answered, so
 * vitest-plugin can test the machine without a deployment. Only an `https` deployment orders; the
 * local stack's `http` origin needs no certificate.
 */

/** What the Galaxy keeps about its pack, in its own storage. */
export interface CertificateState {
  /** A wake recorded that this galaxy needs a pack. Cleared by teardown. */
  wanted: boolean;
  /** The pack's id, once an order has answered with one. */
  packId?: string;
  /** The pack's last status, as the API reported it. */
  status?: string;
  /** Consecutive transient failures, for the retry's backoff. */
  failures?: number;
}

/** The one API call the alarm makes next, if any. */
export type CertificateCall = { kind: 'order' } | { kind: 'poll'; packId: string } | { kind: 'none' };

/** What a call answered: a pack and its status, or a failure worth retrying or not. */
export type CertificateResult =
  | { ok: true; packId: string; status: string }
  | { ok: false; transient: boolean };

/** How long the alarm waits before polling a pack that is not active yet. */
export const POLL_SECONDS = 10;

/**
 * The statuses of a pack Cloudflare is still working on, which the alarm polls again. Any other is
 * final: `active`, or one it does not leave, such as `validation_timed_out` or `deleted`. The
 * wildcard-host experiment saw `pending_validation` and `pending_deployment` on the way to `active`.
 */
const IN_PROGRESS = new Set([
  'initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'staging_deployment', 'holding_deployment',
]);

/** Whether a pack's status is final, so nothing polls it again. */
export function isFinalStatus(status: string | undefined): boolean {
  return status !== undefined && !IN_PROGRESS.has(status);
}
/** The longest the alarm waits before retrying after a transient failure. */
export const MAX_RETRY_SECONDS = 300;

/**
 * What the alarm calls now. A stored pack is polled and never ordered again, so a second wake costs
 * nothing; an order in flight, or a teardown under way, calls nothing.
 */
export function nextCall(state: CertificateState, inFlight: boolean, tearingDown: boolean): CertificateCall {
  if (tearingDown || inFlight || !state.wanted) return { kind: 'none' };
  if (state.packId) return isFinalStatus(state.status) ? { kind: 'none' } : { kind: 'poll', packId: state.packId };
  return { kind: 'order' };
}

/**
 * What a wake does: it records that a pack is wanted and asks for the alarm, and it never calls the
 * API itself, so the alarm handler is the one caller and two wakes cannot order twice.
 */
export function onWake(state: CertificateState, tearingDown: boolean): { state: CertificateState; arm: boolean } {
  if (tearingDown) return { state, arm: false };
  if (isFinalStatus(state.status)) return { state: { ...state, wanted: true }, arm: false };
  return { state: { ...state, wanted: true }, arm: true };
}

/**
 * The state after a call, and when the alarm fires next, in seconds — `undefined` stops it. A
 * status still in progress re-arms; a final one, `active` or a failure such as
 * `validation_timed_out`, stops; a transient failure retries with a doubling backoff; a failure that
 * is not transient stops and leaves the pack unordered, for the log to explain.
 */
export function afterCall(
  state: CertificateState, result: CertificateResult,
): { state: CertificateState; rearmSeconds?: number } {
  if (!result.ok) {
    if (!result.transient) return { state: { ...state, failures: 0 } };
    const failures = (state.failures ?? 0) + 1;
    return { state: { ...state, failures }, rearmSeconds: Math.min(MAX_RETRY_SECONDS, POLL_SECONDS * 2 ** (failures - 1)) };
  }
  const next: CertificateState = { ...state, packId: result.packId, status: result.status, failures: 0 };
  return isFinalStatus(result.status) ? { state: next } : { state: next, rearmSeconds: POLL_SECONDS };
}

/** One step of a galaxy's teardown, in order. */
export type TeardownStep = 'disarm' | 'awaitOrder' | 'deletePacksNamingHost' | 'wipe';

/**
 * A teardown's steps. Disarming comes first, before any `await`, so a wake or an alarm arriving
 * mid-teardown orders nothing; an order already in flight is awaited, so the listing after it sees
 * the pack that order made; and only an `https` deployment, the one that orders, lists packs.
 */
export function teardownSteps(https: boolean, inFlight: boolean): TeardownStep[] {
  if (!https) return ['disarm', 'wipe'];
  return inFlight ? ['disarm', 'awaitOrder', 'deletePacksNamingHost', 'wipe'] : ['disarm', 'deletePacksNamingHost', 'wipe'];
}

/**
 * Whether a pack belongs to the galaxy whose host is `galaxyHost`: it names that host or its wildcard
 * exactly. Every pack names the zone apex, so matching on any host would claim every customer's pack,
 * and a bare suffix would let `crm.acme.lumenize.dev` claim `xcrm.acme.lumenize.dev`'s.
 */
export function packNamesGalaxy(hosts: readonly string[], galaxyHost: string): boolean {
  return hosts.includes(galaxyHost) || hosts.includes(`*.${galaxyHost}`);
}

/** The hosts a galaxy's pack names: the zone apex, the galaxy's host and its wildcard. */
export function packHosts(apex: string, galaxyHost: string): string[] {
  return [apex, galaxyHost, `*.${galaxyHost}`];
}

/** A pack as the API lists it. */
export interface CertificatePack {
  id: string;
  hosts: string[];
  status: string;
}

/** What the Galaxy asks of Cloudflare's certificate-packs API. A test subclass hands in a fake. */
export interface CertificateApi {
  order(hosts: string[]): Promise<CertificateResult>;
  get(packId: string): Promise<CertificateResult>;
  list(): Promise<CertificatePack[]>;
  delete(packId: string): Promise<void>;
}

/** Each API call's own bound, so a stalled Cloudflare never holds a Galaxy's teardown open. */
const CALL_TIMEOUT_MS = 15_000;

/**
 * The real client, for one zone, authorized by a token scoped to that zone's SSL and Certificates.
 * The pack is an advanced pack with TXT validation, 90 days, from Google Trust Services, as the
 * wildcard-host experiment ordered (`experiments/wildcard-host-routing/RESULTS.md`). A 429, a 5xx or
 * a network failure is transient; any other refusal is not.
 */
export function cloudflareCertificateApi(zoneId: string, token: string): CertificateApi {
  const base = `https://api.cloudflare.com/client/v4/zones/${zoneId}/ssl/certificate_packs`;
  const call = async (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const asResult = async (res: Response): Promise<CertificateResult> => {
    if (!res.ok) return { ok: false, transient: res.status === 429 || res.status >= 500 };
    const { result } = await res.json() as { result: { id: string; status: string } };
    return { ok: true, packId: result.id, status: result.status };
  };
  const failed = (): CertificateResult => ({ ok: false, transient: true });
  return {
    order: (hosts) => call('/order', {
      method: 'POST',
      body: JSON.stringify({
        type: 'advanced', hosts, validation_method: 'txt', validity_days: 90,
        certificate_authority: 'google', cloudflare_branding: false,
      }),
    }).then(asResult, failed),
    get: (packId) => call(`/${packId}`).then(asResult, failed),
    // Every page: a zone holds one pack per galaxy, so a galaxy's pack can sit on any of them.
    list: async () => {
      const packs: CertificatePack[] = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const res = await call(`?status=all&per_page=50&page=${page}`);
        if (!res.ok) throw new Error(`certificate packs list answered ${res.status}`);
        const body = await res.json() as { result: CertificatePack[]; result_info?: { total_pages?: number } };
        packs.push(...body.result);
        pages = body.result_info?.total_pages ?? 1;
      }
      return packs;
    },
    delete: async (packId) => {
      const res = await call(`/${packId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`certificate pack delete answered ${res.status}`);
    },
  };
}
