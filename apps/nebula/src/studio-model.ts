/**
 * The codegen model id — the ONE place a vendor id appears. Swappable: Studio is model-agnostic,
 * and the model's name is never shown in the UI or to the model. A leaf, so a Node harness that
 * sends a request to the same model imports it with nothing else.
 */
export const STUDIO_MODEL = '@cf/moonshotai/kimi-k2.7-code';
