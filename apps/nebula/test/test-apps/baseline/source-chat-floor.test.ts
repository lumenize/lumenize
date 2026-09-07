/**
 * The source entries at the CHAT FLOOR (`.claude/rules/security.md`'s design-floor line): `readSource`,
 * `writeSource`, `buildNow` and `appendWorkspaceOntology` carry `requireChatWrite` — DAG
 * `write` at the chat node, the same check a Message create passes at the door — so a
 * collaborator whose message triggers a turn that writes and builds under their own claims
 * can make the same calls directly. Real invited identities, the shape of the real-host
 * block in `confine-dag-plane.test.ts`; every refusal is matched on its MESSAGE (a boundary
 * refusal and a DAG refusal are indistinguishable as booleans).
 *
 *  - F1 the floor: an invited member's `writeSource` is refused without a grant and lands a
 *    commit with one (the same sub, one grant apart — what makes the pair capable of
 *    catching a collapse).
 *  - F2 the path rule, in the ENTRY: a chat-`write` caller's direct write to a reserved path
 *    (`.nebula/…`, `.env`) or a traversal (`../x`) is refused with the reserved-path /
 *    traversal message — distinct from the DAG denial and from a shape error — and neither
 *    the tree nor the registry moves; `./src/App.vue` normalises and lands.
 *  - F3 the wipe bit keeps DOMINION, decided in the body: the same chat-floor caller with no
 *    bit has `{ wipe: false }` accepted and `{ wipe: true }` refused with a message naming the
 *    `.dev` Star; the covering owner's `{ wipe: true }` writes the row, and the debug sink
 *    carries the acting principal's projection.
 *  - F4 a direct write is RECORDED: `writeSource`'s debug line carries the caller's
 *    projection (ADR-016 — a direct edit answers "who and when" as a turn's does).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Browser } from '@lumenize/testing';
import { setDebugSink, clearDebugSink } from '@lumenize/debug';
import { CHAT_NODE_ID, CHAT_MESSAGE_ONTOLOGY_VERSION, DEFAULT_CHAT_ID, deriveKind } from '@lumenize/nebula';
import type { Galaxy, OntologyVersionRow, Snapshot } from '@lumenize/nebula';
import { universeAdminClient, foundAndLogin, createSubject, createInvitedClient } from '../../test-helpers';
import { NebulaClientTest } from './index';

const uniqueScope = () => `scf-${crypto.randomUUID().slice(0, 8)}.app`;
const PAIR = (scope: string) => ({ resourceHostBinding: 'GALAXY', chatHostBinding: 'GALAXY', chatScope: scope });
const OID_RE = /^[0-9a-f]{40}$/;
const TODO_V1 = `interface Todo { title: string; done: boolean; }`;
const TODO_V2 = `interface Todo { title: string; done: boolean; priority: string; }`;
/** The in-lane Apply compiles in place (typia) — well inside this, and a hang still reds. */
const APPLY_TIMEOUT_MS = 60_000;
const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

type SinkEntry = { namespace: string; level: string; message: string; data?: Record<string, unknown> };
let entries: SinkEntry[] = [];
beforeEach(() => { entries = []; setDebugSink((e) => entries.push(e as unknown as SinkEntry)); });
afterEach(() => clearDebugSink());

/** The message a mesh call was refused with, or `null` when it succeeded. */
async function refusal(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
}

/** The owner (a covering universe admin), plus an invited MEMBER logged in at the galaxy —
 *  passage yes, chat-node grant NO, and no admin bit on this session (the fixture guard). */
async function ownerAndMember(scope: string) {
  const { client: owner, accessToken } = await universeAdminClient(
    NebulaClientTest, new Browser(), scope, scope, 'admin@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  const adminBrowser = new Browser();
  await foundAndLogin(adminBrowser, scope, 'admin@example.com', scope);
  await createSubject(adminBrowser, scope, accessToken, 'member@example.com');
  const { client: member, payload } = await createInvitedClient(
    NebulaClientTest, new Browser(), scope, scope, 'member@example.com', CHAT_MESSAGE_ONTOLOGY_VERSION, PAIR(scope),
  );
  // The dangerous shape, asserted: the chat floor is reachable by a grant, and NO dominion
  // anywhere — a co-minted `.dev` membership is a different `sub` on a different session.
  expect(payload.access?.scopeAdmin).toBeFalsy();
  const grantWrite = () => owner.lmz.callAsync('GALAXY', scope,
    owner.ctn<Galaxy>().dagTree().setPermission(CHAT_NODE_ID, payload.sub, 'write'));
  return { owner, member, payload, grantWrite };
}

const galaxy = (c: NebulaClientTest, scope: string) => ({
  read: (path: string) => c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().readSource(path)) as Promise<string>,
  /** The branch head — git writes the ref with a trailing newline. */
  head: async () => (await c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().readSource('.git/refs/heads/main')) as string).trim(),
  write: (path: string, content: string) =>
    c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().writeSource(path, content)) as Promise<{ oid: string; path: string }>,
  apply: (opts: { wipe?: boolean }) =>
    c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().appendWorkspaceOntology(opts), { timeoutMs: APPLY_TIMEOUT_MS }) as Promise<{ version: string }>,
  current: () => c.lmz.callAsync('GALAXY', scope, c.ctn<Galaxy>().getCurrentOntology()) as Promise<OntologyVersionRow | null>,
});

describe('the source entries sit at the chat floor', () => {
  it('F1: an invited member\'s writeSource is refused WITHOUT a chat-node grant and lands a commit WITH one', async () => {
    const scope = uniqueScope();
    const { owner, member, grantWrite } = await ownerAndMember(scope);
    const g = galaxy(member, scope);

    // THE DOOR: refused at the DAG — the message names the tier and the node. Passage
    // admitted the call (a boundary refusal would read `Active-scope mismatch`), and a
    // dominion guard would read `Admin access required` — neither is this.
    const denied = await refusal(g.write('src/App.vue', '<template><p>no</p></template>'));
    expect(denied).toMatch(/^write permission required on node /);
    expect(await refusal(g.read('src/App.vue'))).toMatch(/^write permission required on node /);

    // POSITIVE CONTROL: the covering owner grants `write` at the chat node → the SAME
    // caller's SAME op lands and returns a commit oid.
    await grantWrite();
    const { oid, path } = await g.write('src/App.vue', '<template><p>granted</p></template>');
    expect(oid).toMatch(OID_RE);
    expect(path).toBe('src/App.vue');
    expect(await g.read('src/App.vue')).toBe('<template><p>granted</p></template>');

    owner[Symbol.dispose](); member[Symbol.dispose]();
  });

  it('F2: the path rule binds in the ENTRY — reserved and traversal paths are refused, nothing moves, ./ normalises', async () => {
    const scope = uniqueScope();
    const { owner, member, grantWrite } = await ownerAndMember(scope);
    await grantWrite();
    const g = galaxy(member, scope);

    // Baselines the refused writes must not move: the branch head, and the registry.
    const headBefore = await g.head();
    expect(headBefore).toMatch(OID_RE);
    expect(await g.current()).toBeNull();

    // A registry row `#registryRows()` WOULD parse (a 40-hex label — the read-by-label
    // door refuses anything else), so this negative is capable of failing: without the
    // entry's rule the row lands and `getCurrentOntology()` answers it.
    const label = '0123456789abcdef0123456789abcdef01234567';
    const row = JSON.stringify({ version: label, appliedAt: '2026-01-01T00:00:00.000Z' });
    expect(await refusal(g.write(`.nebula/ontology/${label}.json`, row))).toMatch(/^Reserved path rejected/);
    expect(await refusal(g.write('.env', 'SECRET=1'))).toMatch(/^Reserved path rejected/);
    expect(await refusal(g.write('../x', 'escaped'))).toMatch(/'\.\.' segment rejected/);

    expect(await g.head()).toBe(headBefore); // no new commit
    expect(await g.current()).toBeNull(); // the registry is unchanged

    // The normalisation: a model- or client-written `./` names the same file, and the
    // commit that lands names it without the prefix.
    const { oid, path } = await g.write('./src/App.vue', '<template><p>dot-slash</p></template>');
    expect(oid).toMatch(OID_RE);
    expect(path).toBe('src/App.vue');
    expect(await g.head()).toBe(oid);

    owner[Symbol.dispose](); member[Symbol.dispose]();
  });

  it('F3: the wipe bit keeps DOMINION — a chat-floor caller with no bit may apply but not wipe; the owner\'s wipe writes the row', async () => {
    const scope = uniqueScope();
    const { owner, member, payload, grantWrite } = await ownerAndMember(scope);
    await grantWrite();
    const m = galaxy(member, scope);
    const o = galaxy(owner, scope);

    // A NEW ontology, so the Apply has something to compile (an unchanged source is the
    // already-applied no-op, which decides nothing). The write is the member's own — the
    // chat floor covers `src/ontology.d.ts` like any source file.
    await m.write('src/ontology.d.ts', TODO_V1);
    // The destructive half is refused, naming the Star it would wipe; the plain Apply is
    // the same caller's to make.
    const refused = await refusal(m.apply({ wipe: true }));
    expect(refused).toMatch(/^Wipe refused: dominion over /);
    expect(refused).toContain(`${scope}.dev`);
    expect(await m.current()).toBeNull(); // the refused Apply appended nothing
    const { version } = await m.apply({ wipe: false });
    const applied = await m.current();
    expect(applied?.version).toBe(version);
    expect(applied?.wipeOnInstall).toBeUndefined();

    // The covering owner holds dominion over `{scope}.dev` → the wipe rides the row.
    await o.write('src/ontology.d.ts', TODO_V2);
    entries = [];
    const { version: v2 } = await o.apply({ wipe: true });
    expect(v2).not.toBe(version);
    const head = await o.current();
    expect(head?.version).toBe(v2);
    expect(head?.wipeOnInstall).toBe(true);
    // The ADR-016 record a wipe owes: the acting principal's projection on the decision line.
    const decided = entries.filter((e) =>
      e.namespace === 'nebula.Galaxy.appendWorkspaceOntology' && e.message === 'wipe on install decided');
    expect(decided).toHaveLength(1);
    const token = decided[0]!.data?.actingToken as { sub?: string; access?: { authScope?: string } } | undefined;
    expect(token?.sub).toBe(owner.claims.sub);
    expect(token?.sub).not.toBe(payload.sub);
    expect(token?.access?.authScope).toBe(scope.split('.')[0]);

    owner[Symbol.dispose](); member[Symbol.dispose]();
  });

  it('F4: a direct writeSource is RECORDED — its debug line carries the caller\'s projection', async () => {
    const scope = uniqueScope();
    const { owner, member, payload, grantWrite } = await ownerAndMember(scope);
    await grantWrite();
    const g = galaxy(member, scope);

    entries = [];
    await g.write('src/App.vue', '<template><p>recorded</p></template>');
    const commits = entries.filter((e) => e.namespace === 'nebula.Galaxy.writeSource' && e.message === 'commit');
    expect(commits).toHaveLength(1);
    const data = commits[0]!.data as { path?: string; clientId?: string; actingToken?: { sub?: string; act?: unknown } };
    expect(data.path).toBe('src/App.vue');
    // The projection names the MEMBER (the subject of the verified claims), not the owner
    // who granted them, and the client that made the call. Mutation: strip the claims from
    // the log line → `actingToken` is absent → red.
    expect(data.actingToken?.sub).toBe(payload.sub);
    expect(data.actingToken?.act).toBeUndefined(); // self-acting — no delegation chain
    expect(data.clientId).toBe(member.lmz.instanceName);

    owner[Symbol.dispose](); member[Symbol.dispose]();
  });

  it('F5: a turn finishes under the authority it STARTED with — the grant revoked mid-turn, the reply still lands', async () => {
    // The door's verdict at the post is the turn's one permission decision (Larry,
    // 2026-09-06): the scripted model pauses two seconds before its reply, the OWNER revokes
    // the member's chat-node write inside that window, and the agent reply commits
    // regardless. Observed on the owner's subscription — the member's own read goes with the
    // grant, which the tail proves. Mutation: drop `pinnedAtPost` from `commitAgentMessage`
    // → the commit is refused at the chat node, no reply lands, the wait reds.
    const scope = uniqueScope();
    const { owner, member, payload, grantWrite } = await ownerAndMember(scope);
    await grantWrite();
    owner.callGalaxySeedChatScript(scope, [
      { __delayMs: 2000 },
      { choices: [{ message: { content: 'Still here after the revoke.', reasoning_content: '', tool_calls: [] } }] },
    ]);
    using sub = owner.resources.subscribeQuery(chatQuery); await sub.ready;
    const posted = await member.postUserMessage('are you there?');
    await owner.lmz.callAsync('GALAXY', scope, owner.ctn<Galaxy>().dagTree().revokePermission(CHAT_NODE_ID, payload.sub));
    try {
      await vi.waitFor(async () => {
        const snaps = await Promise.all(sub.resourceIds.map((id) => owner.resources.read('Message', id) as Promise<Snapshot | null>));
        const reply = snaps.find((x) => x && deriveKind(x.meta.actingToken) === 'agent' && (x.value as { replyTo?: string }).replyTo === posted);
        expect(reply).toBeTruthy();
        expect((reply!.value as { content?: string }).content).toBe('Still here after the revoke.');
      }, { timeout: 15000 });
    } catch (e) {
      // A red says WHY: the Galaxy's own turn entries ride the sink.
      const turn = entries.filter((x) => /nebula\.Galaxy\.(trigger|stream)/.test(x.namespace))
        .map((x) => `${x.level} ${x.namespace} ${x.message} ${JSON.stringify(x.data?.error ?? '')}`);
      throw new Error(`${e instanceof Error ? e.message : String(e)} — the Galaxy's turn entries: ${turn.join(' | ').slice(0, 1500)}`);
    }
    // The premise held — the grant is gone: the member's direct write is refused now.
    expect(await refusal(galaxy(member, scope).write('src/x.txt', 'x'))).toMatch(/write permission required on node/);
  });
});
