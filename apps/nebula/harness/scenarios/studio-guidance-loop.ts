/**
 * The model in the loop, OBSERVED — the guidance file tree's exploratory half. One fresh
 * Galaxy, one real session, the real model over the REST lane, no container: every limb
 * asks whether the guidance the tree carries changes what the model produces, and REPORTS
 * the answer. Nothing here gates on the model.
 *
 * What is ASSERTED — the pipeline: every turn lands a durable reply inside the deadline (a
 * broken transport is silence, and the deadline is what makes it loud). What is REPORTED —
 * the limbs, each with its own positive control, printed as a findings table for the
 * master plan's § *Data-bound generation* (one dated line each):
 *
 *  (a) asked for a wishlist, the app the model writes reads and writes through `store` /
 *      `client.resources` — the 2026-09-03 hand-driven failure, reproduced or not;
 *  (b) "no countdown timers" stated in turn one is honoured by the next turn's output, and
 *      is still in `AGENTS.md` after N further turns (N = HARNESS_GUIDANCE_TURNS, default 10);
 *  (c) after the stated convention, the reply names `AGENTS.md`;
 *  (d) a request matching `define-ontology` reads the skill body — visible in the read
 *      tool's call log (`codegen.toolCalls`);
 *  (f) asked what was requested first, the reply names it.
 *
 * ⚠️ Container-free BY DESIGN (`needsContainer = false`), so every sweep runs it; the
 * `build` tool therefore answers with a failed container step and the model must cope —
 * which is itself something worth watching. The limbs that need a build live in
 * `first-app-built`; the four-party limb (e) lives in `four-party-chat`.
 *
 * Requires the REST lane: `WORKERS_AI_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `.dev.vars`.
 */
import assert from 'node:assert/strict';
import { DEFAULT_CHAT_ID } from '@lumenize/nebula/client';
import type { Galaxy, Snapshot } from '@lumenize/nebula';
import { deriveKind } from '@lumenize/nebula/client';
import type { DevStack, Driver } from '../lib/harness';
import { connectDriver, readDevVar } from '../lib/harness';

export const needsContainer = false;

const SCOPE = `claude-${crypto.randomUUID().slice(0, 8)}.guidance`;
/** A cold real turn — generation plus a few failed-build rounds at most — lives inside this. */
const TURN_TIMEOUT_MS = 900_000; // tracks the server's 14 min generation deadline plus margin (32-round cap)
const FURTHER_TURNS = Number(process.env.HARNESS_GUIDANCE_TURNS ?? '10');

const chatQuery = { queryType: 'parentChild' as const, typeName: 'Message', field: 'chat', value: DEFAULT_CHAT_ID };

type Codegen = { toolCalls?: Array<{ name: string; args?: unknown; result?: unknown; error?: string }>; appliedPaths?: string[]; stop?: string; rounds?: number };
type Reply = { content: string; codegen?: Codegen };

/** Post, then wait for the durable agent reply — the ASSERTED half of every turn. */
async function turn(driver: Driver, sub: { resourceIds: string[] }, text: string): Promise<Reply> {
  const t0 = Date.now();
  const id = await driver.client.postUserMessage(text);
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    for (const rid of sub.resourceIds) {
      const snap = await driver.client.resources.read('Message', rid) as Snapshot | null;
      if (snap && deriveKind(snap.meta.actingToken) === 'agent' && (snap.value as { replyTo?: string }).replyTo === id) {
        const v = snap.value as { content?: string; codegen?: Codegen };
        console.error(`  ↳ turn "${text.slice(0, 48)}…" replied in ${((Date.now() - t0) / 1000).toFixed(1)}s — stop=${v.codegen?.stop} rounds=${v.codegen?.rounds} applied=${(v.codegen?.appliedPaths ?? []).join(',') || '-'}`);
        return { content: v.content ?? '', codegen: v.codegen };
      }
    }
    assert.ok(Date.now() < deadline,
      `no agent reply to "${text.slice(0, 48)}" within ${TURN_TIMEOUT_MS / 1000}s — the turn runs detached, so a broken model call is SILENCE here and this deadline is what makes it loud`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const read = (driver: Driver, path: string) =>
  driver.client.lmz.callAsync('GALAXY', SCOPE, driver.client.ctn<Galaxy>().readSource(path)) as Promise<string>;

export async function run(stack: DevStack): Promise<void> {
  const optional = (name: string) => { try { return readDevVar(name); } catch { return undefined; } };
  assert.ok(optional('WORKERS_AI_TOKEN') && optional('CLOUDFLARE_ACCOUNT_ID'),
    'this scenario watches the REAL model over the REST lane — WORKERS_AI_TOKEN + CLOUDFLARE_ACCOUNT_ID must be in .dev.vars');

  // Three outcomes: pass, fail, and `asked` — the model chose to ask about the shape before
  // building, which the ontology skill makes its own judgment (Larry, 2026-09-06), so a limb
  // that needed a build reports that it was not exercised rather than a fail.
  type Outcome = boolean | 'asked';
  const findings: Array<{ limb: string; pass: Outcome; note: string }> = [];
  const report = (limb: string, pass: Outcome, note: string) => {
    findings.push({ limb, pass, note });
    console.error(`  ${pass === true ? '✓' : pass === 'asked' ? '·' : '✗'} limb ${limb} — ${note}`);
  };

  const driver = await connectDriver(stack, { scope: SCOPE });
  try {
    using sub = driver.client.resources.subscribeQuery(chatQuery); await sub.ready;

    // ── (b)+(c) turn one: a convention, stated ───────────────────────────────────────────
    const r1 = await turn(driver, sub,
      'One rule for this app, before we build anything: no countdown timers, ever. Please note it down.');
    const agentsAfter1 = await read(driver, 'AGENTS.md');
    const recorded = /countdown/i.test(agentsAfter1);
    report('(c)', /AGENTS\.md/.test(r1.content),
      recorded
        ? `the convention landed in AGENTS.md; the reply ${/AGENTS\.md/.test(r1.content) ? 'names' : 'does NOT name'} the file`
        : 'the convention was NOT written to AGENTS.md (the reply: ' + JSON.stringify(r1.content.slice(0, 120)) + ')');

    // ── (a) the data-bound request ───────────────────────────────────────────────────────
    const r2 = await turn(driver, sub,
      'Build me a wishlist app: add an item with a name and a link, list the items, and let me remove one. Everyone in the group sees the list.');
    const app = await read(driver, 'src/App.vue').catch(() => '');
    const usesStore = /store\.resources|client\.resources|from ['"]\.\/nebula['"]/.test(app);
    const wroteApp = (r2.codegen?.appliedPaths ?? []).includes('src/App.vue');
    // The prompt names fields, so the skill's judgment allows asking first: a reply that
    // asks and writes nothing is `asked`, not a fail — the gap this limb watches for is a
    // written App.vue holding user data OUTSIDE resources.
    const asked = !wroteApp && r2.content.includes('?');
    report('(a)', wroteApp ? usesStore : (asked ? 'asked' : false),
      wroteApp
        ? (usesStore ? 'App.vue reads and writes through store/client.resources' : 'App.vue was written but holds user data OUTSIDE resources — the 2026-09-03 gap, reproduced')
        : asked
          ? `the model asked about the shape before building (the prompt names fields — the skill's judgment): ${JSON.stringify(r2.content.slice(0, 140))}`
          : `no App.vue was written and nothing was asked (stop=${r2.codegen?.stop}, rounds=${r2.codegen?.rounds})`);
    // (b) first half: the convention honoured by the next turn's output.
    // No App.vue this turn is NOT a pass — an unexercised limb reports as a fail, never green.
    report('(b1)', wroteApp ? !/countdown|setInterval\(/i.test(app) : (asked ? 'asked' : false),
      wroteApp ? (/countdown/i.test(app) ? 'the next turn\'s App.vue mentions a countdown despite the rule' : 'the next turn\'s output honours "no countdown timers"') : (asked ? 'not exercised — the model asked first' : 'no App.vue this turn and nothing asked — not exercised, counted as a fail'));
    // (d) did a data-bound request activate the ontology skill?
    const reads = (r2.codegen?.toolCalls ?? []).filter((t) => t.name === 'read_file').map((t) => (t.args as { path?: string })?.path ?? '');
    report('(d)', reads.includes('.platform/skills/define-ontology/SKILL.md'),
      reads.length > 0 ? `read_file calls this turn: ${reads.join(', ')}` : 'the turn read no file at all');

    // ── (b) second half: N further turns, then the line is still there ───────────────────
    for (let i = 0; i < FURTHER_TURNS; i++) {
      await turn(driver, sub, [
        'What does the app do so far? One sentence, no code changes.',
        'Which files exist in this project? Answer briefly, change nothing.',
        'Remind me of the rules we have set for this app. Do not change any code.',
      ][i % 3]!);
    }
    const agentsAfterN = await read(driver, 'AGENTS.md');
    report('(b2)', /countdown/i.test(agentsAfterN),
      `after ${FURTHER_TURNS} further turns the rule is ${/countdown/i.test(agentsAfterN) ? 'still' : 'NO LONGER'} in AGENTS.md (${agentsAfterN.length} bytes)`);

    // ── (f) what was requested first ─────────────────────────────────────────────────────
    const rf = await turn(driver, sub, 'What was the very first thing I asked you for in this chat? One sentence, change nothing.');
    report('(f)', /countdown|timer|rule/i.test(rf.content),
      `the reply: ${JSON.stringify(rf.content.slice(0, 140))}`);

    console.error('\n[studio-guidance-loop] FINDINGS — copy into tasks/nebula-pre-alpha.md § Data-bound generation § Findings:');
    const today = new Date().toISOString().slice(0, 10);
    for (const f of findings) console.error(`- ${today} · ${f.limb} · ${f.pass === true ? 'pass' : f.pass === 'asked' ? 'asked' : 'fail'} · ${f.note}`);
    console.error(`[studio-guidance-loop] ${findings.filter((f) => f.pass === true).length}/${findings.length} limbs passed, ${findings.filter((f) => f.pass === 'asked').length} asked — reported, never gated`);
  } finally {
    driver.dispose();
  }
}
