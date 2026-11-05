#!/usr/bin/env node
/**
 * Apply and restore named mutations, so a mutation check can't corrupt the tree it tests.
 *
 *   node scripts/mutate.mjs list    <table.mjs>
 *   node scripts/mutate.mjs apply   <table.mjs> <name>
 *   node scripts/mutate.mjs restore <table.mjs> <name>
 *   node scripts/mutate.mjs run     <table.mjs> <name> -- <command> [args…]
 *
 * A table is a throwaway module, usually in a session's scratchpad, mapping each mutation's name
 * to one or more exact-match edits, with paths relative to the repo root:
 *
 *   export default {
 *     'no-grace': { edits: [{ file: 'packages/mesh/src/client-gateway.ts',
 *                             from: 'this.#startGracePeriod(name);',
 *                             to: '// MUTATION no-grace' }] },
 *   };
 *
 * The safety `.claude/rules/testing.md` asks for:
 * - **Exact counts both ways.** An edit applies only if its `from` occurs exactly once in its file
 *   and its `to` will then occur exactly once, so the restore can find it; a `from` that also ends
 *   some other statement is refused, not half-applied. Neither string may be empty: to delete a
 *   line, replace it with a marker comment. Every edit is checked before any file is written.
 * - **No restore over someone else's change.** Apply records each file's hash; restore refuses a
 *   file whose content changed since, so an edit made under a mutation is never reversed blindly.
 * - **One mutation at a time per repo**, recorded in a state file under the OS temp directory.
 * - **`run` always restores**, when the command fails, when it passes, and on Ctrl-C, which it
 *   forwards to the command and reports as no verdict. The command runs as a child the event loop
 *   waits on, so a signal is handled while it runs rather than after.
 *
 * `run` exits 0 when the command FAILED, meaning the mutation was caught, and 1 when it passed,
 * meaning the mutation survived. Whether the RIGHT test failed is still the caller's to read.
 */
import { createHash } from 'node:crypto';
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const STATE = join(tmpdir(), 'lumenize-mutate', `${createHash('sha256').update(ROOT).digest('hex').slice(0, 16)}.json`);

const sha = (text) => createHash('sha256').update(text).digest('hex');
const count = (text, needle) => text.split(needle).length - 1;

function fail(message) {
  console.error(`mutate: ${message}`);
  process.exit(2);
}

/** @returns {Promise<Record<string, { edits: Array<{ file: string, from: string, to: string }> }>>} */
async function loadTable(path) {
  if (!path) fail('name a table module');
  const table = (await import(pathToFileURL(resolve(path)).href)).default;
  if (!table || typeof table !== 'object') fail(`${path} has no default export`);
  return table;
}

function mutationOf(table, name) {
  const m = table[name];
  if (!m || !Array.isArray(m.edits) || m.edits.length === 0) {
    fail(`no mutation "${name}"; the table has: ${Object.keys(table).join(', ')}`);
  }
  return m;
}

/** Rewrite every edit's file, checking every count before writing anything. */
function rewrite(edits, direction) {
  const files = new Map();
  for (const edit of edits) {
    const path = join(ROOT, edit.file);
    if (!files.has(path)) {
      if (!existsSync(path)) fail(`${edit.file} does not exist`);
      files.set(path, readFileSync(path, 'utf8'));
    }
    const [needle, replacement] = direction === 'apply' ? [edit.from, edit.to] : [edit.to, edit.from];
    if (!edit.from || !edit.to) fail(`${edit.file}: an edit's from and to must both be non-empty`);
    const text = files.get(path);
    const n = count(text, needle);
    if (n !== 1) {
      fail(`${direction}: ${edit.file} has ${n} matches for ${JSON.stringify(needle.slice(0, 80))}, ` +
        'and needs exactly 1. Nothing was written.');
    }
    const next = text.replace(needle, () => replacement);
    if (direction === 'apply' && count(next, replacement) !== 1) {
      fail(`apply: ${edit.file} would hold ${JSON.stringify(replacement.slice(0, 80))} ` +
        `${count(next, replacement)} times, so the restore could not find it. Nothing was written.`);
    }
    files.set(path, next);
  }
  for (const [path, text] of files) writeFileSync(path, text);
  return [...files.keys()];
}

function apply(table, name) {
  if (existsSync(STATE)) {
    const state = JSON.parse(readFileSync(STATE, 'utf8'));
    fail(`"${state.name}" is still applied; restore it first`);
  }
  const written = rewrite(mutationOf(table, name).edits, 'apply');
  mkdirSync(join(tmpdir(), 'lumenize-mutate'), { recursive: true });
  const hashes = Object.fromEntries(written.map((p) => [p, sha(readFileSync(p, 'utf8'))]));
  writeFileSync(STATE, JSON.stringify({ name, hashes }));
  console.error(`mutate: applied "${name}" to ${written.map((p) => p.slice(ROOT.length + 1)).join(', ')}`);
}

function restore(table, name) {
  if (!existsSync(STATE)) fail(`nothing is applied`);
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  if (state.name !== name) fail(`"${state.name}" is applied, not "${name}"`);
  for (const [path, hash] of Object.entries(state.hashes)) {
    if (sha(readFileSync(path, 'utf8')) !== hash) {
      fail(`${path.slice(ROOT.length + 1)} changed after "${name}" was applied; restore it by hand`);
    }
  }
  const written = rewrite(mutationOf(table, name).edits, 'restore');
  rmSync(STATE);
  console.error(`mutate: restored "${name}" in ${written.map((p) => p.slice(ROOT.length + 1)).join(', ')}`);
}

const [command, tablePath, name, ...rest] = process.argv.slice(2);
const table = await loadTable(tablePath);
switch (command) {
  case 'list':
    for (const [n, m] of Object.entries(table)) console.log(`${n}\t${m.edits.map((e) => e.file).join(', ')}`);
    break;
  case 'apply':
    apply(table, name);
    break;
  case 'restore':
    restore(table, name);
    break;
  case 'run': {
    const argv = rest[0] === '--' ? rest.slice(1) : rest;
    if (argv.length === 0) fail('run needs a command after --');
    apply(table, name);
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    let interrupted;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => { interrupted = signal; child.kill(signal); });
    }
    const status = await new Promise((done) => {
      child.on('exit', (code) => done(code));
      child.on('error', (e) => { console.error(`mutate: could not start ${argv[0]}: ${e.message}`); done(127); });
    });
    restore(table, name);
    if (interrupted) {
      console.error(`mutate: "${name}" was interrupted by ${interrupted}; restored, with no verdict`);
      process.exit(130);
    }
    const caught = status !== 0;
    console.error(`mutate: "${name}" ${caught ? `was CAUGHT (the command exited ${status})` : 'SURVIVED (the command passed)'}`);
    process.exit(caught ? 0 : 1);
  }
  default:
    fail('usage: mutate.mjs list|apply|restore <table.mjs> [name] | run <table.mjs> <name> -- <command…>');
}
