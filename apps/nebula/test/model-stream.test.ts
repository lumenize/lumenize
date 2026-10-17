/**
 * The SSE assembler — pure, so this is its tier. The sample is the shape Kimi actually streams
 * over Workers AI REST (captured 2026-09-03), trimmed: reasoning deltas, a tool call in fragments,
 * the finish, the usage-only chunk, the Workers-AI trailer, and [DONE].
 */
import { describe, it, expect } from 'vitest';
import { assembleStream, reduceChunk, newAccumulator, finishAccumulator, DELTA_BATCH_CHARS } from '../src/model-stream';

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish, index: 0 }], id: 'x', object: 'chat.completion.chunk' })}\n`;

const SAMPLE = [
  chunk({ content: '', reasoning_content: null, role: 'assistant' }),
  ...['The', ' user', ' wants', ' a', ' file', ' named', ' hello', '.txt', '.', ' I', ' should', ' use', ' the', ' tool', '.'].map((t) => chunk({ reasoning_content: t })),
  chunk({ content: null, reasoning_content: null, role: null, tool_calls: [{ function: { arguments: '', name: 'write_file' }, id: 'call_1', index: 0, type: 'function' }] }),
  chunk({ tool_calls: [{ function: { arguments: '{"path', name: null }, id: null, index: 0, type: 'function' }] }),
  chunk({ tool_calls: [{ function: { arguments: '": "hello.txt", "content": "', name: null }, id: null, index: 0, type: 'function' }] }),
  chunk({ tool_calls: [{ function: { arguments: 'hello"}', name: null }, id: null, index: 0, type: 'function' }] }),
  chunk({ reasoning_content: null }, 'tool_calls'),
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 89, completion_tokens: 51 } })}\n`,
  'data: {"response":"","usage":{"prompt_tokens":89,"completion_tokens":51}}\n',
  'data: [DONE]\n',
].join('\n');

function streamOf(text: string, pieces = 7): ReadableStream<Uint8Array> {
  // Cut at arbitrary byte offsets so a line straddles reads — the assembler must re-join it.
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let i = 0;
  return new ReadableStream({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(i, i + size)); i += size; } });
}

describe('assembleStream', () => {
  it('rebuilds the whole-response shape the loop parses — reasoning, a complete tool call, the finish', async () => {
    const out = await assembleStream(streamOf(SAMPLE));
    const msg = out.choices[0]!.message;
    expect(msg.reasoning_content).toBe('The user wants a file named hello.txt. I should use the tool.');
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls![0]!.function.name).toBe('write_file');
    expect(msg.tool_calls![0]!.id).toBe('call_1');
    expect(JSON.parse(msg.tool_calls![0]!.function.arguments)).toEqual({ path: 'hello.txt', content: 'hello' });
    expect(out.choices[0]!.finish_reason).toBe('tool_calls');
    expect(out.usage).toEqual({ prompt_tokens: 89, completion_tokens: 51 });
  });

  it('hands the reasoning out live, batched, in order, and complete', async () => {
    const deltas: string[] = [];
    await assembleStream(streamOf(SAMPLE, 11), (t) => deltas.push(t));
    expect(deltas.join('')).toBe('The user wants a file named hello.txt. I should use the tool.');
    expect(deltas.length).toBeGreaterThan(1);                           // batched, not one lump…
    expect(deltas.length).toBeLessThan(15);                             // …and not one per token
    for (const d of deltas.slice(0, -1)) expect(d.length).toBeGreaterThanOrEqual(DELTA_BATCH_CHARS);
  });

  it('is byte-boundary agnostic — the same result however the stream is cut', async () => {
    const a = await assembleStream(streamOf(SAMPLE, 1));
    const b = await assembleStream(streamOf(SAMPLE, 40));
    expect(b).toEqual(a);
  });

  it('reduceChunk: a tool call assembled across fragments keeps its id and name from the first', () => {
    const acc = newAccumulator();
    reduceChunk(acc, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'f', arguments: '' } }] } }] });
    reduceChunk(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] } }] });
    reduceChunk(acc, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
    const tc = finishAccumulator(acc).choices[0]!.message.tool_calls!;
    expect(tc).toEqual([{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]);
  });
});
