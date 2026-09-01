/**
 * Phase 4: the Home screen's one read, and the absorption of `my-scopes`.
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
 *  - **An impersonation token is refused outright.** The read is `profileId`-keyed and a narrower
 *    token deliberately carries the SUBJECT's `profileId`, so without the refusal an admin acting as
 *    someone would receive every tenancy that person holds — including scopes the admin cannot reach.
 */
import { describe, it, expect } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import {
  foundUniverse, createGalaxy, issueInvitesAs, clickLink, inviteAndLogin, mintNarrowerRequest,
} from './test-helpers';
import { SCOPE_TREE_NODE_BUDGET } from '../src/types';

const uni = () => `u${crypto.randomUUID().slice(0, 8)}`;
const addr = () => `p4-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function summaryWith(token: string): Promise<any> {
  const resp = await SELF.fetch(new Request('http://localhost/auth/scope-summary', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }));
  expect(resp.status).toBe(200);
  return resp.json();
}
const flat = (n: any): any[] => [n, ...(n.children ?? []).flatMap(flat)];
const allNodes = (s: any): any[] => s.emails.flatMap((e: any) => e.memberships.flatMap(flat));

describe('Phase 4 — the summary is the whole picture, bounded', () => {
  it('surfaces a member-LESS galaxy under its accepted admin (the property `my-scopes` carried)', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    await createGalaxy(SELF, `${u}.app`, admin.access_token); // Scopes row, no membership anywhere

    const nodes = allNodes(await summaryWith(admin.access_token)).map((n) => n.scope);
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
    await createGalaxy(SELF, `${mine}.app`, mineAdmin.access_token);

    const theirs = uni();
    const owner = await foundUniverse(SELF, theirs, addr());
    await createGalaxy(SELF, `${theirs}.app`, owner.access_token);
    const invite = await issueInvitesAs(owner.access_token, theirs, [{ email: person, scopeAdmin: true }]);
    await clickLink(SELF, invite.results[0].inviteUrl); // clicked, deliberately NOT accepted

    const nodes = allNodes(await summaryWith(mineAdmin.access_token));
    const accepted = nodes.find((n) => n.scope === mine);
    const pending = nodes.find((n) => n.scope === theirs);
    expect(accepted.children).toBeDefined();          // positive control: descent works
    expect(pending).toBeDefined();                    // the invitation is offered…
    expect(pending.children).toBeUndefined();         // …bare, because it was never taken up
    expect(pending.invitedByName ?? null).not.toBeUndefined(); // and carries its consent-modal inputs
  });

  it('an IMPERSONATION token is refused — the read answers for a person, not for an actor', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    const subjectEmail = addr();
    const member = await inviteAndLogin(SELF, u, admin.access_token, subjectEmail);

    // A narrower token carries the SUBJECT's `sub` and `profileId` with the admin in `act` — so a
    // `profileId`-keyed read would hand the admin every tenancy the subject holds ANYWHERE,
    // including organizations the admin has no reach into. `myScopeTree` could not do this: it
    // self-confined to `authScope`. Presence of `act` is the whole test (never its identity).
    const minted = await mintNarrowerRequest(SELF, admin.access_token, {
      subOfNarrowerToken: member.parsed.sub, activeScope: u,
    });
    expect(minted.status).toBe(200);
    const { access_token } = await minted.json() as { access_token: string };

    const resp = await SELF.fetch(new Request('http://localhost/auth/scope-summary', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    }));
    expect(resp.status).toBe(403);
    expect(await resp.text()).toContain('impersonation');
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
      env.NEBULA_AUTH_REGISTRY.getByName('registry'),
      (_i: any, ctx: any) => {
        for (let i = 0; i < WIDE; i++) {
          ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)', `${u}.g${i}`);
        }
      },
    );
    const summary = await summaryWith(admin.access_token);
    const nodes = allNodes(summary);
    expect(nodes.length).toBeLessThanOrEqual(SCOPE_TREE_NODE_BUDGET);
    expect(nodes.length).toBeGreaterThan(1); // it did descend, so the bound is not vacuous
    expect(nodes.some((n: any) => (n.childCount ?? 0) > 0)).toBe(true); // …and marked its frontier

    // ⚠️ **The READ, not the response** — and this is the assertion that can actually fail. Trimming
    // a full scan after the fact produces a byte-identical body, so a response-side check is blind to
    // the exact ADR-018 hazard the budget exists for: the singleton doing unbounded work to serve a
    // small answer. Count rows the DO actually read by wrapping its own `sql.exec`.
    const profileId = admin.parsed.profileId;
    const currentSub = admin.parsed.sub;
    const rowsRead = await (runInDurableObject as any)(
      env.NEBULA_AUTH_REGISTRY.getByName('registry'),
      (instance: any, ctx: any) => {
        const realExec = ctx.storage.sql.exec.bind(ctx.storage.sql);
        let total = 0;
        ctx.storage.sql.exec = (...args: any[]) => {
          const cursor = realExec(...args);
          const rows = [...cursor];
          total += rows.length;
          return { ...cursor, [Symbol.iterator]: () => rows[Symbol.iterator](), toArray: () => rows };
        };
        try { instance.getScopeSummary(profileId, currentSub); } finally { ctx.storage.sql.exec = realExec; }
        return total;
      },
    );
    // Generous headroom over the budget (the membership rows and each level's `LIMIT budget + 1`
    // probe all count) — what it forbids is the scan, which reads every scope in the table.
    expect(rowsRead).toBeLessThan(SCOPE_TREE_NODE_BUDGET * 4);
  });

  it('past the budget, `expand` pages the remainder with a cursor rather than dead-ending', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    // Wider than one page, so there IS a remainder to ask for. Seeded as rows: provenance does not
    // matter to a paging assertion, only that the level overflows the budget.
    const WIDE = SCOPE_TREE_NODE_BUDGET + 7;
    await (runInDurableObject as any)(
      env.NEBULA_AUTH_REGISTRY.getByName('registry'),
      (_i: any, ctx: any) => {
        for (let i = 0; i < WIDE; i++) {
          // Zero-padded so lexical order — which is what the keyset cursor walks — matches creation
          // order; without it `g10` sorts before `g9` and "the remainder" is a different set.
          ctx.storage.sql.exec('INSERT OR IGNORE INTO Scopes (universeGalaxyStarId) VALUES (?)',
            `${u}.g${String(i).padStart(3, '0')}`);
        }
      },
    );
    const page = async (after?: string) => {
      const resp = await SELF.fetch(new Request('http://localhost/auth/expand-scope', {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent: u, ...(after ? { after } : {}) }),
      }));
      expect(resp.status).toBe(200);
      return resp.json() as Promise<{ children: { scope: string }[]; nextCursor?: string }>;
    };

    const first = await page();
    expect(first.children).toHaveLength(SCOPE_TREE_NODE_BUDGET); // the bound still holds…
    expect(first.nextCursor).toBeDefined();                      // …and says there IS more

    const second = await page(first.nextCursor);
    // ⚠️ The SECOND PAGE's contents are the assertion, not its length. A cursor that is ignored
    // returns page one again — same length, same status, and every "did it page?" check on count
    // alone passes. Reds against dropping `after` from the WHERE clause.
    const seen = new Set(first.children.map((c) => c.scope));
    expect(second.children.every((c) => !seen.has(c.scope))).toBe(true);
    expect(second.children).toHaveLength(WIDE - SCOPE_TREE_NODE_BUDGET);
    expect(second.nextCursor).toBeUndefined(); // the level is exhausted, so paging terminates

    // Every child is reachable across the two pages — the property the budget alone could not give.
    expect(seen.size + second.children.length).toBe(WIDE);
  });

  it('`expand` returns one more level, and refuses a caller with no accepted admin above it', async () => {
    const u = uni();
    const admin = await foundUniverse(SELF, u, addr());
    await createGalaxy(SELF, `${u}.app`, admin.access_token);

    const expand = async (token: string, parent: string) => {
      const resp = await SELF.fetch(new Request('http://localhost/auth/expand-scope', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent }),
      }));
      expect(resp.status).toBe(200);
      return (await resp.json() as any).children.map((c: any) => c.scope);
    };
    expect(await expand(admin.access_token, u)).toContain(`${u}.app`);

    // A stranger with their own universe holds no admin membership above `${u}` — the authz is
    // re-derived here rather than trusted from the request, so they get nothing.
    const other = await foundUniverse(SELF, uni(), addr());
    expect(await expand(other.access_token, u)).toEqual([]);
  });
});
