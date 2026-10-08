/**
 * The Home screen's one read, and the absorption of `my-scopes`.
 *
 * The summary answers for a PERSON — every address on their `profileId`, every membership on those
 * addresses, and the tree beneath the ones they administer. Four properties are load-bearing:
 *
 *  - **The subtree comes from `Scopes`, not `Memberships`.** A galaxy someone just created has no
 *    member yet; an email-keyed read would not surface it, which is the property the retired
 *    `myScopeTree` existed to provide and this must not lose.
 *  - **The READ is bounded, not just the response.** The old method's platform arm was
 *    `SELECT … FROM Scopes` entire. Here each level is fetched with `LIMIT budget + 1` and the
 *    frontier is reported as `childCount`, so a superuser costs what anyone else costs.
 *  - **Eager descent requires an ACCEPTED admin membership.** Until someone has taken a membership
 *    up it confers nothing (ADR-012), so fleshing its subtree would answer with unheld authority.
 *  - **No token reaches it.** Home's summary authenticates by the browser's refresh cookies on the
 *    platform host, never by a Bearer, so an impersonation token — which deliberately carries the
 *    SUBJECT's `profileId` — buys an admin none of the tenancies that person holds elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import {
  foundUniverse, createGalaxy, issueInvitesAs, inviteAndLogin, registryStub, verifiedClaims, authUrl,
  plainLogin, refreshCookie, platformLogin,
} from './test-helpers';
import { mintImpersonationToken } from '../../src/auth/worker-token';
import { SCOPE_TREE_NODE_BUDGET, PLATFORM_SCOPE } from '../../src/auth/types';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p4-${crypto.randomUUID().slice(0, 8)}@example.com`;

/** Home's summary for the one person whose cookies `cookieHeader` carries. */
async function summaryWith(cookieHeader: string): Promise<any> {
  const resp = await SELF.fetch(new Request(authUrl('home-summary'), {
    method: 'POST', headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' }, body: '{}',
  }));
  expect(resp.status).toBe(200);
  const { groups } = await resp.json() as { groups: { summary: any }[] };
  expect(groups).toHaveLength(1); // one person, one Profile
  return groups[0].summary;
}
const flat = (n: any): any[] => [n, ...(n.children ?? []).flatMap(flat)];
const allNodes = (s: any): any[] => s.emails.flatMap((e: any) => e.memberships.flatMap(flat));

describe('the summary is the whole picture, bounded', () => {
  it('surfaces a member-LESS galaxy under its accepted admin (the property `my-scopes` carried)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    await createGalaxy(`${u}.app`, admin.access_token); // Scopes row, no membership anywhere

    const nodes = allNodes(await summaryWith(refreshCookie(u, admin.refreshToken))).map((n) => n.scope);
    // Reds if the descent is sourced from `Memberships`: nobody is a member of `${u}.app`, so an
    // email-keyed read returns the universe alone and the user-developer's own app disappears.
    expect(nodes).toContain(`${u}.app`);
  });

  it('an UNACCEPTED admin membership renders bare — no subtree until it is taken up', async () => {
    // The person holds TWO admin memberships: one they took up, one invitation they have not.
    // Both are in the same summary, so the accepted one is the positive control — without it this
    // could pass on a build that never descends at all.
    const person = addr();
    const mine = uni();
    const mineAdmin = await foundUniverse(SELF, mine, person);
    await createGalaxy(`${mine}.app`, mineAdmin.access_token);

    const theirs = uni();
    const owner = await foundUniverse(SELF, theirs, addr());
    await createGalaxy(`${theirs}.app`, owner.access_token);
    await issueInvitesAs(owner.access_token, theirs, [{ email: person, scopeAdmin: true }]);
    const { tokenFor } = await plainLogin(SELF, person); // signed in, the invitation NOT accepted

    const nodes = allNodes(await summaryWith(
      `${refreshCookie(mine, tokenFor(mine))}; ${refreshCookie(theirs, tokenFor(theirs))}`,
    ));
    const accepted = nodes.find((n) => n.scope === mine);
    const pending = nodes.find((n) => n.scope === theirs);
    expect(accepted.children).toBeDefined();          // positive control: descent works
    expect(pending).toBeDefined();                    // the invitation is offered…
    expect(pending.children).toBeUndefined();         // …bare, because it was never taken up
    expect(pending.invitedByName ?? null).not.toBeUndefined(); // and carries its consent-modal inputs
  });

  it('an IMPERSONATION token buys nothing — the read answers a browser\'s cookies, never a token', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const subjectEmail = addr();
    const member = await inviteAndLogin(SELF, u, admin.access_token, subjectEmail);

    // A narrower token carries the SUBJECT's `sub` and `profileId` with the admin in `act` — so a
    // `profileId`-keyed read that accepted a token would hand the admin every tenancy the subject
    // holds ANYWHERE, including organizations the admin has no reach into. The summary reads the
    // browser's refresh cookies instead, which an impersonating page does not hold.
    const minted = await mintImpersonationToken(env as Env, await verifiedClaims(admin.access_token), member.parsed.sub);
    if (!minted.ok) throw new Error(`refused: ${minted.message}`);

    const resp = await SELF.fetch(new Request(authUrl('home-summary'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }));
    expect(resp.status).toBe(401);
    expect(await resp.text()).not.toContain(member.parsed.profileId);
  });

  it('the READ is bounded — a wide tree reports a frontier instead of scanning', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    // ⚠️ **Far wider than the budget, seeded directly.** The gap between a bounded read and a scan is
    // only visible when there is much more to scan than the budget allows — with a handful of extra
    // rows the two read almost the same number and the assertion below cannot fail. Provenance does
    // not matter for a read-cost assertion, only the row count, so these go in as rows.
    const WIDE = 400;
    await (runInDurableObject as any)(
      env.AUTH_REGISTRY.getByName('registry'),
      (_i: any, ctx: any) => {
        for (let i = 0; i < WIDE; i++) {
          ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', `${u}.g${i}`);
        }
      },
    );
    const summary = await summaryWith(refreshCookie(u, admin.refreshToken));
    const nodes = allNodes(summary);
    expect(nodes.length).toBeLessThanOrEqual(SCOPE_TREE_NODE_BUDGET);
    expect(nodes.length).toBeGreaterThan(1); // it did descend, so the bound is not vacuous
    expect(nodes.some((n: any) => (n.childCount ?? 0) > 0)).toBe(true); // …and marked its frontier

    // ⚠️ **The READ, not the response** — and this is the assertion that can actually fail. Trimming
    // a full scan after the fact produces a byte-identical body, so a response-side check is blind to
    // the exact ADR-018 hazard the budget exists for: the singleton doing unbounded work to serve a
    // small answer. Count rows the DO actually read by wrapping its own `sql.exec`.
    const profileId = admin.parsed.profileId;
    const rowsRead = await (runInDurableObject as any)(
      env.AUTH_REGISTRY.getByName('registry'),
      (instance: any, ctx: any) => {
        const realExec = ctx.storage.sql.exec.bind(ctx.storage.sql);
        let total = 0;
        ctx.storage.sql.exec = (...args: any[]) => {
          const cursor = realExec(...args);
          const rows = [...cursor];
          total += rows.length;
          return { ...cursor, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        };
        try { instance.getScopeSummary(profileId); } finally { ctx.storage.sql.exec = realExec; }
        return total;
      },
    );
    // Generous headroom over the budget (the membership rows and each level's `LIMIT budget + 1`
    // probe all count) — what it forbids is the scan, which reads every scope in the table.
    expect(rowsRead).toBeLessThan(SCOPE_TREE_NODE_BUDGET * 4);
  });

  it("the platform root's level marks its frontier too, past a budget's worth of accounts", async () => {
    // The root's own row matches its level's pattern and sorts first ('_' before any slug), so a
    // read that spent its `LIMIT budget + 1` sentinel on it saw no truncation and handed a superuser
    // a full-looking first page with no `childCount` (a deployed run holding ~50 accounts, 2026-10-07).
    // Seeded directly, as the wide tree above is: only the row count matters to a frontier.
    const { refreshToken } = await platformLogin(SELF);
    await (runInDurableObject as any)(
      env.AUTH_REGISTRY.getByName('registry'),
      (_i: any, ctx: any) => {
        for (let i = 0; i < SCOPE_TREE_NODE_BUDGET * 2; i++) {
          ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', uni());
        }
      },
    );
    const summary = await summaryWith(refreshCookie(PLATFORM_SCOPE, refreshToken));
    const root = allNodes(summary).find((n: any) => n.scope === PLATFORM_SCOPE);
    expect(root.children.length).toBeGreaterThan(0);
    expect(root.children.some((c: any) => c.scope === PLATFORM_SCOPE)).toBe(false);
    // Mutation: drop the root's row from the SQL exclusion and leave only the JS filter → undefined.
    expect(root.childCount).toBeGreaterThan(root.children.length);
  });

  it('past the budget, `expand` pages the remainder with a cursor rather than dead-ending', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    // Wider than one page, so there IS a remainder to ask for. Seeded as rows: provenance does not
    // matter to a paging assertion, only that the level overflows the budget.
    const WIDE = SCOPE_TREE_NODE_BUDGET + 7;
    await (runInDurableObject as any)(
      env.AUTH_REGISTRY.getByName('registry'),
      (_i: any, ctx: any) => {
        for (let i = 0; i < WIDE; i++) {
          // Zero-padded so lexical order — which is what the keyset cursor walks — matches creation
          // order; without it `g10` sorts before `g9` and "the remainder" is a different set.
          ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)',
            `${u}.g${String(i).padStart(3, '0')}`);
        }
      },
    );
    // The Registry's own method, handed the admin's verified claims as `AuthFacade.expandScope`
    // hands them; the parent is the token's `aud`, the universe page itself.
    const claims = await verifiedClaims(admin.access_token);
    const page = async (after?: string) =>
      await registryStub().expandScope(claims, after) as { children: { scope: string }[]; nextCursor?: string };

    const first = await page();
    expect(first.children).toHaveLength(SCOPE_TREE_NODE_BUDGET); // the bound still holds…
    expect(first.nextCursor).toBeDefined();                      // …and says there IS more

    const second = await page(first.nextCursor);
    // ⚠️ The SECOND PAGE's contents are the assertion, not its length. A cursor that is ignored
    // returns page one again — same length, same status, and every "did it page?" check on count
    // alone passes. Reds against dropping `after` from the WHERE clause.
    const seen = new Set(first.children.map((c) => c.scope));
    expect(second.children.every((c) => !seen.has(c.scope))).toBe(true);
    // The claim's first app is one more child of the universe, beside the seeded rows.
    expect(second.children).toHaveLength(WIDE + 1 - SCOPE_TREE_NODE_BUDGET);
    expect(second.nextCursor).toBeUndefined(); // the level is exhausted, so paging terminates

    // Every child is reachable across the two pages — the property the budget alone could not give.
    expect(seen.size + second.children.length).toBe(WIDE + 1);
  });

  it('`expand` returns one more level, and refuses a caller with no accepted admin above it', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    await createGalaxy(`${u}.app`, admin.access_token);

    const expand = async (claims: object) =>
      ((await registryStub().expandScope(claims)) as any).children.map((c: any) => c.scope);
    expect(await expand(await verifiedClaims(admin.access_token))).toContain(`${u}.app`);

    // A stranger with their own universe holds no admin membership above `${u}`. The Registry
    // re-derives that from memberships rather than trusting the claims it is handed — the check a
    // caller that skipped the facade would meet — so a claims object naming `${u}` as its page,
    // which no verified token of theirs could carry, still gets nothing.
    const other = await foundUniverse(SELF, uni(), addr());
    expect(await expand({ ...await verifiedClaims(other.access_token), aud: u })).toEqual([]);
  });
});
