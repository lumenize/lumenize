/**
 * The codegen model id — the ONE place a vendor id appears. Swappable: Studio is model-agnostic,
 * and the model's name is never shown in the UI or to the model. A leaf, so a Node harness that
 * sends a request to the same model imports it with nothing else.
 *
 * GLM-5.3 since 2026-11-20, when Workers AI deprecated Kimi K2.7 Code (error 5028, `410 Gone`).
 * Its replies and streamed deltas carry the keys Kimi's did: `content`, `reasoning_content` and
 * `tool_calls`, probed that day.
 */
export const STUDIO_MODEL = '@cf/zai-org/glm-5.3';

/**
 * What every request to {@link STUDIO_MODEL} sends beside the conversation, kept here with the id
 * because it is the model's own knob. GLM-5.3 reasons at `max` unless told otherwise; at `max` it
 * spent a whole round's budget thinking before writing a file (2026-11-20), and `high` costs fewer
 * tokens.
 */
export const STUDIO_MODEL_OPTIONS = { reasoning_effort: 'high' } as const;
