/**
 * The local stack's debug output, parsed — for scenarios that assert on what a request recorded.
 *
 * A stack started by the harness captures its `wrangler dev` stdio (`DevStack.logs`); a deployed
 * target has none, so every reader here takes the capture as optional and a scenario MUST report a
 * limb built on it as not observable there (`live-scenarios.md` § *Reading the local stack's logs*).
 */
import type { DevStack } from './harness';

/** One `@lumenize/debug` JSON block from the stdio, with its position among them. */
export type DebugLine = {
  namespace: string; message: string; level?: string; data: Record<string, any>; idx: number;
};

/** Every JSON debug block in `raw`, in order. wrangler pretty-prints each as a `{`…`}` block. */
export function debugLines(raw: string): DebugLine[] {
  const out: DebugLine[] = [];
  for (const block of raw.replace(/\x1b\[[0-9;]*m/g, '').split(/\n(?=\{\n)/)) {
    const end = block.indexOf('\n}');
    if (end < 0) continue;
    try {
      const obj = JSON.parse(block.slice(0, end + 2)) as Omit<DebugLine, 'idx'>;
      if (obj.namespace) out.push({ ...obj, data: obj.data ?? {}, idx: out.length });
    } catch { /* not one of ours */ }
  }
  return out;
}

/**
 * The parsed stdio once `ready` holds of it. The stack's stdio reaches the harness late and in
 * bursts, so a limb waits for a line its own request logs after the thing it reads (`live.md`).
 * Throws naming `what` when it never arrives.
 */
export async function waitForDebugLines(
  stack: DevStack, ready: (all: DebugLine[]) => boolean, what: string, timeoutMs = 20_000,
): Promise<DebugLine[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const all = debugLines(stack.logs?.() ?? '');
    if (ready(all)) return all;
    if (Date.now() > deadline) throw new Error(`the stack's stdio never showed ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
