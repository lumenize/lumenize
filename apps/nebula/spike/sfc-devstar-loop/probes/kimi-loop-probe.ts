/**
 * Stage C of the Kimi UI-gen probe (tasks/kimi-ui-gen-viability.md): a thin,
 * self-rolled agentic iterate-on-errors loop — **NO Think, no agent framework**.
 *
 * Proves two things for the "do we need Think?" question:
 *  1. The loop is trivial to roll yourself (the whole thing is below).
 *  2. Kimi 2.7 self-corrects when errors are fed back — the natural test is the
 *     `op:'set'` bug Stage B surfaced (real ops are create/put/delete/move).
 *
 * The "check" = the Stage-A compile (real) + an API-op lint that STANDS IN for
 * the real platform's transaction validation. The live-platform version (run the
 * transaction against a dev Star, get real validation/permission errors) arrives
 * with build-seq #1. Run: `npx tsx probes/kimi-loop-probe.ts`. SPENDS CREDIT.
 */
import { readFileSync } from 'node:fs';
import { compileSFCToModule } from '../src/compile-module';

const DEV_VARS = '/Users/larry/Projects/mcp/lumenize/.dev.vars';
const readVar = (name: string): string | undefined => {
  const m = readFileSync(DEV_VARS, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};
const ACCOUNT = readVar('CLOUDFLARE_ACCOUNT_ID')!;
const KEY = readVar('CLOUDFLARE_GLOBAL_API_KEY')!;
const EMAIL = process.env.CF_EMAIL ?? 'larry@maccherone.com';
const MODEL = process.argv[2] ?? '@cf/moonshotai/kimi-k2.7-code';
const MAX_ROUNDS = 4;

// NOTE: deliberately does NOT enumerate the valid transaction ops — so the loop
// has the Stage-B `op:'set'` bug to discover and fix. Otherwise faithful to
// website/docs/nebula/coding-your-ui.md.
const SYSTEM = `You generate the UI for an app on the Nebula platform: Vue 3 Single-File
Components in TypeScript, styled with DaisyUI, rendering "resources" declared in a
TypeScript ontology. The framework handles subscribe, transactions, and conflicts.

- Read: store.resources.<resourceType>[<id>].value (auto-subscribes; undefined until first
  snapshot, so guard with ?. and a fallback).
- Write a field with v-model; v-model can't use ?., so guard the input with v-if:
    <template v-if="store.resources.todo[id]?.value"><input v-model="store.resources.todo[id].value.title" /></template>
- Lists use a container resource whose value holds an array of ids, keyed per user by client.claims.sub.
- Mutations: client.resources.transaction({ [id]: { op, typeName, nodeId?, value } }). Create a new
  resource and append its id to the container in ONE transaction. Use crypto.randomUUID() for ids.
- Components import { store, client } from './nebula'. Do NOT write nebula.ts/main.ts/index.html.
  App.vue uses <script setup lang="ts">.
- Ontology: plain TS interfaces, one per resource type; relationships are stored by id (string/string[]).

OUTPUT: respond with EXACTLY two fenced code blocks, nothing else:
1) \`\`\`vue   — App.vue
2) \`\`\`typescript   — ontology.d.ts`;

const USER = `Build a simple todo app. One todo list per user. Each todo has a title and a
done/open status. Show the list, add a todo, toggle done, edit a title inline, and show a
live count of open todos.`;

const VALID_OPS = new Set(['create', 'put', 'delete', 'move']);

/** Stand-in for the platform's compile + transaction validation. */
function checkApp(appVue: string): string[] {
  const errors: string[] = [];
  const compiled = compileSFCToModule(appVue, 'kimi-app');
  for (const e of compiled.errors) errors.push(`compile error: ${e}`);
  // API-op lint — what the real transaction validator would reject at runtime.
  const ops = new Set([...appVue.matchAll(/\bop:\s*['"]([a-zA-Z]+)['"]/g)].map((m) => m[1]));
  for (const op of ops) {
    if (!VALID_OPS.has(op)) {
      errors.push(`transaction validation: unknown op '${op}'. Valid ops are: create | put | delete | move.`);
    }
  }
  return errors;
}

function extractBlock(text: string, langs: string[]): string | undefined {
  for (const lang of langs) {
    const m = text.match(new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i'));
    if (m) return m[1].trim();
  }
  return undefined;
}

async function callKimi(messages: Array<{ role: string; content: string }>): Promise<string> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
    method: 'POST',
    headers: { 'X-Auth-Email': EMAIL, 'X-Auth-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, max_tokens: 8192 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: { response?: string; choices?: Array<{ message?: { content?: string } }> } };
  const content = json.result?.choices?.[0]?.message?.content ?? json.result?.response;
  if (!content) throw new Error('No content: ' + JSON.stringify(json).slice(0, 500));
  return content;
}

console.log(`\n=== Stage C: thin iterate-on-errors loop (no Think) — model ${MODEL} ===\n`);

const messages: Array<{ role: string; content: string }> = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: USER },
];

let converged = false;
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const output = await callKimi(messages);
  const appVue = extractBlock(output, ['vue', 'html']);
  if (!appVue) {
    console.log(`Round ${round}: ❌ no App.vue block in response — stopping.`);
    console.log('--- RAW (first 1200 chars) ---\n' + output.slice(0, 1200) + '\n--- END ---');
    break;
  }
  const errors = checkApp(appVue);
  console.log(`Round ${round}: ${errors.length === 0 ? '✅ clean' : `❌ ${errors.length} problem(s)`}`);
  for (const e of errors) console.log('   - ' + e);

  if (errors.length === 0) {
    converged = true;
    console.log(`\n✅ Converged in ${round} round(s). Final App.vue compiles + passes op validation.`);
    break;
  }
  // Feed the errors back — this is the entire "loop": append the model's answer
  // and a corrective user turn, then call again.
  messages.push({ role: 'assistant', content: output });
  messages.push({
    role: 'user',
    content:
      `The generated code has problems:\n${errors.map((e) => '- ' + e).join('\n')}\n\n` +
      `Fix them and return the corrected App.vue and ontology.d.ts (both full files, same two-fenced-block format).`,
  });
}

if (!converged) console.log(`\n❌ Did not converge within ${MAX_ROUNDS} rounds.`);
console.log('\n=== DONE ===');
