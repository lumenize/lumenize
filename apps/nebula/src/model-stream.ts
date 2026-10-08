/**
 * Streamed model completions — the SSE chunks reassembled into the whole-response shape the
 * codegen loop already parses, with the text deltas handed out live along the way.
 *
 * Why reassemble rather than teach the loop to stream: the loop needs the COMPLETE `tool_calls`
 * to act (an argument string is JSON only once every fragment has arrived), so streaming buys
 * display, not decisions. `parseModelTurn` stays untouched; this module produces exactly what the
 * non-streaming call returned, from a stream. Shape measured 2026-09-03 against
 * `@cf/moonshotai/kimi-k2.7-code` over Workers AI REST: OpenAI-style chunks where
 * `delta.reasoning_content` streams token by token first, then `delta.tool_calls[]` fragments
 * keyed by `index` (name/id on the first, `arguments` pieces after), `finish_reason` on the last
 * content chunk, a usage-only chunk with `choices: []`, a Workers-AI `{response: ""}` trailer, then
 * `[DONE]`. The `env.AI` binding streams the same bytes.
 *
 * Deltas are BATCHED by size (never by timer — the reducer is pure), so a 50-token-per-second
 * thought reaches the transient channel a few times a second instead of fifty.
 */

export interface StreamedToolCall { id?: string; type?: string; function: { name?: string; arguments: string } }

export interface AssembledCompletion {
  choices: Array<{
    index: number;
    finish_reason: string | null;
    message: { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: StreamedToolCall[] };
  }>;
  usage?: unknown;
}

/** The reducer's state — exported so a test can drive it chunk by chunk. */
export interface StreamAccumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, StreamedToolCall>;
  finishReason: string | null;
  usage?: unknown;
  /** Text since the last emission — batched by {@link DELTA_BATCH_CHARS} or a newline. */
  pendingDelta: string;
}

/** Emit once this much text (or a newline) has accumulated — a few pushes a second at token pace. */
export const DELTA_BATCH_CHARS = 32;

export function newAccumulator(): StreamAccumulator {
  return { content: '', reasoning: '', toolCalls: new Map(), finishReason: null, pendingDelta: '' };
}

/** Fold ONE parsed SSE payload into the accumulator; returns text ready to emit, if any. */
export function reduceChunk(acc: StreamAccumulator, payload: unknown): string | undefined {
  const p = payload as {
    choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string | null; type?: string | null; function?: { name?: string | null; arguments?: string | null } }> };
      finish_reason?: string | null }>;
    usage?: unknown;
  } | null;
  if (!p || typeof p !== 'object') return undefined;
  if (p.usage !== undefined) acc.usage = p.usage;
  const choice = p.choices?.[0];
  if (!choice) return undefined;
  const d = choice.delta ?? {};
  if (typeof d.reasoning_content === 'string' && d.reasoning_content) { acc.reasoning += d.reasoning_content; acc.pendingDelta += d.reasoning_content; }
  if (typeof d.content === 'string' && d.content) { acc.content += d.content; acc.pendingDelta += d.content; }
  for (const tc of d.tool_calls ?? []) {
    const i = tc.index ?? 0;
    const cur = acc.toolCalls.get(i) ?? { function: { arguments: '' } };
    if (tc.id) cur.id = tc.id;
    if (tc.type) cur.type = tc.type;
    if (tc.function?.name) cur.function.name = tc.function.name;
    if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    acc.toolCalls.set(i, cur);
  }
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  if (acc.pendingDelta.length >= DELTA_BATCH_CHARS || acc.pendingDelta.includes('\n')) {
    const out = acc.pendingDelta; acc.pendingDelta = ''; return out;
  }
  return undefined;
}

/** What the non-streaming call would have returned. */
export function finishAccumulator(acc: StreamAccumulator): AssembledCompletion {
  const toolCalls = [...acc.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc);
  return {
    choices: [{
      index: 0,
      finish_reason: acc.finishReason,
      message: {
        role: 'assistant',
        content: acc.content.length > 0 ? acc.content : null,
        ...(acc.reasoning.length > 0 ? { reasoning_content: acc.reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
    }],
    ...(acc.usage !== undefined ? { usage: acc.usage } : {}),
  };
}

/** Parse the `data:` payloads out of an SSE text, tolerating a chunk boundary mid-line. */
export function* sseEvents(text: string): Generator<unknown> {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (data === '[DONE]' || data.length === 0) continue;
    try { yield JSON.parse(data); } catch { /* a partial line — the caller re-feeds the remainder */ }
  }
}

/**
 * Drain an SSE byte stream into a completion, calling `onDelta` with batched text along the way.
 * A line split across two reads is kept back until its remainder arrives.
 */
export async function assembleStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<AssembledCompletion> {
  const acc = newAccumulator();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let carry = '';
  for (;;) {
    const { value, done } = await reader.read();
    const text = carry + (value ? decoder.decode(value, { stream: !done }) : '');
    const cut = done ? text.length : text.lastIndexOf('\n') + 1;
    carry = text.slice(cut);
    for (const payload of sseEvents(text.slice(0, cut))) {
      const out = reduceChunk(acc, payload);
      if (out !== undefined) onDelta?.(out);
    }
    if (done) break;
  }
  if (acc.pendingDelta.length > 0) { onDelta?.(acc.pendingDelta); acc.pendingDelta = ''; }
  return finishAccumulator(acc);
}
