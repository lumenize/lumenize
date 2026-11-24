/**
 * Ask a frame Studio holds to run code, as Studio does for the agent's `run_in_tab`.
 *
 * It posts the same message Studio's `TabRunner` posts, from Studio's own page to the frame, and
 * reads the page's answer as the runner reads it: the value arrives in the encoding of
 * `@lumenize/structured-clone` and is decoded here, so a `Map` a page returns is a `Map` in the
 * scenario. Every step is one Studio's page takes.
 */
import type { Page } from 'playwright';
import { postprocess } from '@lumenize/structured-clone';

/** A run's answer, decoded: the code's value, or the error it threw. */
export type FrameAnswer = { ok: true; value: any } | { ok: false; error: string };

/**
 * Run `code` in the frame of Studio's `page` titled `title`. Answers `null` when Studio holds no
 * such frame, or the frame's page answers nothing inside `timeoutMs`, as one still loading does.
 */
export async function askFrame(page: Page, title: string, code: string, timeoutMs = 30_000): Promise<FrameAnswer | null> {
  // The page's side is a string, since a function tsx compiles gains a helper the page lacks.
  const data = await page.evaluate(`new Promise((resolve) => {
    const frame = document.querySelector('iframe[title=' + ${JSON.stringify(JSON.stringify(title))} + ']');
    if (!frame || !frame.contentWindow) { resolve(null); return; }
    const origin = new URL(frame.src).origin;
    const id = 'harness-' + crypto.randomUUID().slice(0, 8);
    let timer;
    function on(e) {
      if (e.source !== frame.contentWindow || e.origin !== origin || !e.data || e.data.type !== 'lumenize:ran' || e.data.id !== id) return;
      clearTimeout(timer);
      removeEventListener('message', on);
      resolve(e.data);
    }
    timer = setTimeout(() => { removeEventListener('message', on); resolve(null); }, ${timeoutMs});
    addEventListener('message', on);
    frame.contentWindow.postMessage({ type: 'lumenize:run', id, code: ${JSON.stringify(code)} }, origin);
  })`) as { ok?: boolean; encoded?: unknown; error?: string } | null;
  if (data === null) return null;
  return data.ok === true
    ? { ok: true, value: postprocess(data.encoded as Parameters<typeof postprocess>[0]) }
    : { ok: false, error: data.error ?? 'the page gave no reason' };
}
