/**
 * Stage B of the Kimi UI-gen viability probe (tasks/kimi-ui-gen-viability.md).
 *
 * One-shot signal: give Kimi 2.7 the coding-your-ui patterns + ask for a todo
 * app, then compile whatever it emits with the Stage-A pipeline. Answers "can
 * Kimi produce a `.vue` + `.d.ts` that actually compiles?" — NOT the full
 * agentic iterate-on-errors loop (that's later).
 *
 * Auth: Workers AI REST via the account global key (X-Auth-Email/X-Auth-Key),
 * read from the root .dev.vars. Run: `npx tsx probes/kimi-gen-probe.ts [model]`.
 * SPENDS WORKERS AI CREDIT (cents).
 */
import { readFileSync } from 'node:fs';
import { compileSFCToModule } from '../src/compile-module';

const DEV_VARS = '/Users/larry/Projects/mcp/lumenize/.dev.vars';
const readVar = (name: string): string | undefined => {
  const m = readFileSync(DEV_VARS, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const ACCOUNT = readVar('CLOUDFLARE_ACCOUNT_ID');
const KEY = readVar('CLOUDFLARE_GLOBAL_API_KEY');
const EMAIL = process.env.CF_EMAIL ?? 'larry@maccherone.com';
const MODEL = process.argv[2] ?? '@cf/moonshotai/kimi-k2.7-code';

if (!ACCOUNT || !KEY) {
  console.error('Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_GLOBAL_API_KEY in .dev.vars');
  process.exit(1);
}

const SYSTEM = `You generate the UI for an app on the Nebula platform: Vue 3 Single-File
Components in TypeScript, styled with DaisyUI (Tailwind classes), rendering "resources"
whose shape is declared in a TypeScript ontology. The framework handles subscribe,
transactions, and conflicts — you only write components + the ontology.

RESOURCE ACCESS (the store):
- Read a resource value:  store.resources.<resourceType>[<resourceId>].value
- Reads auto-subscribe. value is undefined until the first snapshot arrives, so guard
  reads with ?. and provide a fallback, e.g. {{ store.resources.todo[id]?.value?.title ?? 'Loading…' }}
- Write a field with v-model (optimistic + debounced). v-model can't use ?., so guard
  the input with v-if so it only mounts once the value exists:
    <template v-if="store.resources.todo[id]?.value">
      <input v-model="store.resources.todo[id].value.title" />
    </template>

LISTS use a container resource whose value holds an array of IDs (foreign keys),
keyed per user by client.claims.sub:
  <li v-for="todoId in store.resources.todoList[client.claims.sub]?.value?.items ?? []" :key="todoId">
    {{ store.resources.todo[todoId]?.value?.title ?? '...' }}
  </li>

WRITES use client.resources.transaction({ [id]: { op, typeName, nodeId?, value } }).
Create a new resource and append its id to the container in ONE transaction.
Use crypto.randomUUID() for new ids.

BOOTSTRAP: components import { store, client } from './nebula'. Do NOT write nebula.ts,
main.ts, or index.html — those are auto-scaffolded. App.vue uses <script setup lang="ts">.

ONTOLOGY: a .d.ts-style file of plain TS interfaces, one per resource type. A field
typed as another ontology type is a relationship stored by id (string / string[]),
never an embedded object.

OUTPUT FORMAT — respond with EXACTLY two fenced code blocks and nothing else:
1) \`\`\`vue   — the contents of App.vue
2) \`\`\`typescript   — the contents of ontology.d.ts`;

const USER = `Build a simple todo app. A user has one todo list. Each todo has a title and a
done/open status. Show the list, let the user add a todo, toggle done, and edit a title
inline. Show a live count of open todos.`;

function extractBlock(text: string, langs: string[]): string | undefined {
  for (const lang of langs) {
    const m = text.match(new RegExp('```' + lang + '\\s*\\n([\\s\\S]*?)```', 'i'));
    if (m) return m[1].trim();
  }
  return undefined;
}

console.log(`\n=== Kimi UI-gen probe — model: ${MODEL} ===\n`);

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
  {
    method: 'POST',
    headers: { 'X-Auth-Email': EMAIL, 'X-Auth-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ],
      max_tokens: 8192,
    }),
  },
);

if (!res.ok) {
  console.error(`HTTP ${res.status} ${res.statusText}`);
  console.error(await res.text());
  process.exit(1);
}

const json = (await res.json()) as {
  result?: { response?: string; choices?: Array<{ message?: { content?: string } }> };
  success?: boolean;
  errors?: unknown;
};
// Kimi 2.7 on Workers AI returns the OpenAI-style chat shape (result.choices[].message.content);
// older models use result.response. Accept either.
const output = json.result?.choices?.[0]?.message?.content ?? json.result?.response;
if (!output) {
  console.error('Workers AI returned no usable content:', JSON.stringify(json, null, 2).slice(0, 2000));
  process.exit(1);
}
console.log('--- RAW MODEL OUTPUT ---\n' + output + '\n--- END RAW OUTPUT ---\n');

const appVue = extractBlock(output, ['vue', 'html']);
const ontology = extractBlock(output, ['typescript', 'ts']);

console.log('Extracted App.vue:', appVue ? `${appVue.length} chars` : 'NOT FOUND');
console.log('Extracted ontology.d.ts:', ontology ? `${ontology.length} chars` : 'NOT FOUND');

if (!appVue) {
  console.error('\n❌ No App.vue block found — cannot compile.');
  process.exit(1);
}

console.log('\n=== COMPILING App.vue ===');
const compiled = compileSFCToModule(appVue, 'kimi-app');
if (compiled.errors.length > 0) {
  console.log('❌ COMPILE ERRORS:');
  for (const e of compiled.errors) console.log('  - ' + e);
} else {
  console.log('✅ Compiled clean.');
  console.log(`   script: ${compiled.script.length} chars, render: ${compiled.render.length} chars, styles: ${compiled.styles.length}`);
  console.log(`   module: ${compiled.module.length} chars (assembled ESM)`);
}
console.log('\n=== DONE ===');
