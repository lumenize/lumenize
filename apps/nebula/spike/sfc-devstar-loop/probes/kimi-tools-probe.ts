/**
 * Verify whether @cf/moonshotai/kimi-k2.7-code supports native function/tool
 * calling via the Workers AI OpenAI-style API (request `tools`, response
 * `choices[].message.tool_calls`). If yes, a thin loop can use structured tool
 * calls — fixing the free-form-output fragility Stage C hit — without Think.
 * Run: `npx tsx probes/kimi-tools-probe.ts`. SPENDS CREDIT.
 */
import { readFileSync } from 'node:fs';

const DEV_VARS = '/Users/larry/Projects/mcp/lumenize/.dev.vars';
const readVar = (name: string) =>
  readFileSync(DEV_VARS, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
const ACCOUNT = readVar('CLOUDFLARE_ACCOUNT_ID')!;
const KEY = readVar('CLOUDFLARE_GLOBAL_API_KEY')!;
const EMAIL = process.env.CF_EMAIL ?? 'larry@maccherone.com';
const MODEL = process.argv[2] ?? '@cf/moonshotai/kimi-k2.7-code';

const tools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write a source file to the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path, e.g. App.vue' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`, {
  method: 'POST',
  headers: { 'X-Auth-Email': EMAIL, 'X-Auth-Key': KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: 'You write files by calling the write_file tool. Always use the tool; do not put code in your text reply.' },
      { role: 'user', content: 'Create a file named hello.txt containing the text: hello world' },
    ],
    tools,
    tool_choice: 'auto',
    max_tokens: 1024,
  }),
});

console.log(`HTTP ${res.status}`);
const json = (await res.json()) as any;
const msg = json?.result?.choices?.[0]?.message;
const toolCalls = msg?.tool_calls;
const finish = json?.result?.choices?.[0]?.finish_reason;

console.log('finish_reason:', finish);
console.log('tool_calls present:', Array.isArray(toolCalls) && toolCalls.length > 0);
if (toolCalls?.length) {
  console.log('tool_calls:', JSON.stringify(toolCalls, null, 2).slice(0, 1200));
} else {
  console.log('message.content (first 600):', String(msg?.content ?? '').slice(0, 600));
  console.log('\n(no tool_calls — raw result first 800):\n' + JSON.stringify(json?.result ?? json).slice(0, 800));
}
