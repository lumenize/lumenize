/**
 * The cast an app's `docs/personas.md` names: each persona's slug and name, read from the lines
 * of its *The cast* section. Studio shows a tab for each, and the agent's `run_in_tab` accepts
 * each slug as a tab.
 *
 * The file is written in plain words for people and for the model, and only this much of it is
 * read by code: a list line that opens with a persona's slug in backticks.
 *
 *     ## The cast
 *
 *     - `mary` — Mary Manager. Runs the account, and sees every deal.
 *     - `gerry` — Gerry Salesperson. Works his own deals.
 *
 * Pure, with no `cloudflare:workers` in its graph, so Studio and the tests import it too.
 */
import { isPersonaSlug } from '@lumenize/mesh/client';

/** One persona of an app's cast: its slug, which is its tab and its host's label, and its name. */
export interface CastEntry {
  slug: string;
  /** The words after the slug up to the first full stop: "Mary Manager". Empty when there are none. */
  name: string;
}

/** The heading the cast's lines sit under, at any level. */
const CAST_HEADING = /^#{1,6}\s+the cast\s*$/i;

/**
 * The cast `markdown` names, in the order written. A line counts when it sits under the *The cast*
 * heading, is a list item, and opens with a persona slug in backticks; a slug named twice counts
 * once. A file with no such section, or none of whose lines qualify, names no cast.
 */
export function parseCast(markdown: string): CastEntry[] {
  const cast: CastEntry[] = [];
  let inSection = false;
  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line)) { inSection = CAST_HEADING.test(line.trim()); continue; }
    if (!inSection) continue;
    const item = /^\s*[-*]\s+`([^`]+)`(.*)$/.exec(line);
    if (!item || !isPersonaSlug(item[1]!) || cast.some((c) => c.slug === item[1])) continue;
    const name = item[2]!.replace(/^[\s—–:-]+/, '').split(/\.(?:\s|$)/)[0]!.trim();
    cast.push({ slug: item[1]!, name });
  }
  return cast;
}
