/**
 * Invariants of the committed platform embed (src/platform-embed.ts, GENERATED from
 * apps/nebula/platform/ + website/docs/nebula/*.md by scripts/gen-platform.mjs — a one-shot
 * generator, not a dev-loop build step). BYTE-level drift, the frontmatter and the
 * on-disk link check are gated by `node scripts/gen-platform.mjs --check` in the package
 * `test` script (a workerd isolate has no fs); what THIS file pins is what can be asserted
 * from `PLATFORM_FILES` alone — the contract the read tool and the always-on layer depend
 * on: the catalog equals the skills' frontmatter, and every `.platform/` path any embedded
 * file names is a key. Each is capable of failing against a hand-edited embed, which is the
 * one thing `--check` cannot see once the edit is regenerated over.
 */
import { describe, it, expect } from 'vitest';
import { PLATFORM_FILES, PLATFORM_AGENTS_MD } from '../src/platform-embed';

/** The catalog line shape `scripts/gen-platform.mjs` renders: `- name — description (location)`. */
const CATALOG_LINE = /^- (\S+) — (.+) \((\.platform\/skills\/[^/]+\/SKILL\.md)\)$/;
/** Same regex as the generator's: a `.platform/` path ends on a path character. */
const PLATFORM_PATH_RE = /\.platform\/[A-Za-z0-9_\-./]*[A-Za-z0-9_\-/]/g;

function frontmatter(text: string): { name?: string; description?: string } {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  const out: { name?: string; description?: string } = {};
  for (const line of block.split('\n')) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].trim();
  }
  return out;
}

describe('platform-embed invariants', () => {
  const skillKeys = Object.keys(PLATFORM_FILES).filter((k) => /^\.platform\/skills\/[^/]+\/SKILL\.md$/.test(k)).sort();

  it('carries the platform AGENTS.md, three seed skills and every Nebula doc page', () => {
    expect(PLATFORM_FILES['.platform/AGENTS.md']).toBe(PLATFORM_AGENTS_MD);
    expect(skillKeys).toEqual([
      '.platform/skills/define-ontology/SKILL.md',
      '.platform/skills/define-the-cast/SKILL.md',
      '.platform/skills/wire-a-view/SKILL.md',
    ]);
    // The resource core's two named pages — the ones the always-on layer sends the model to.
    expect(PLATFORM_FILES['.platform/docs/resources.md']).toContain('# Resources');
    expect(PLATFORM_FILES['.platform/docs/coding-your-ui.md']).toContain('# Coding your UI');
  });

  it('the catalog in AGENTS.md lists every skill, and each line equals that skill\'s frontmatter', () => {
    const lines = PLATFORM_AGENTS_MD.split('\n').filter((l) => CATALOG_LINE.test(l));
    // Mutation: hand-edit one catalog line's description in the embed → its frontmatter no
    // longer matches → red. Drop a skill's line → the count reds.
    expect(lines).toHaveLength(skillKeys.length);
    const seen = new Set<string>();
    for (const line of lines) {
      const [, name, description, location] = CATALOG_LINE.exec(line)!;
      const fm = frontmatter(PLATFORM_FILES[location] ?? '');
      expect(location).toBe(`.platform/skills/${name}/SKILL.md`);
      expect(fm.name).toBe(name);
      expect(fm.description).toBe(description);
      seen.add(location);
    }
    expect([...seen].sort()).toEqual(skillKeys);
    // The marker itself never ships — the generator replaces it.
    expect(PLATFORM_AGENTS_MD).not.toContain('<!-- SKILLS CATALOG');
  });

  it('every .platform/ path any embedded file names is a key (or a directory a key sits under)', () => {
    const keys = new Set(Object.keys(PLATFORM_FILES));
    const resolves = (p: string) => keys.has(p) || (p.endsWith('/') && [...keys].some((k) => k.startsWith(p)));
    const dangling: string[] = [];
    let hits = 0;
    for (const [key, text] of Object.entries(PLATFORM_FILES)) {
      for (const hit of text.match(PLATFORM_PATH_RE) ?? []) {
        hits++;
        const path = hit.replace(/#.*$/, '');
        if (!resolves(path)) dangling.push(`${key} → ${path}`);
      }
    }
    // Positive control: the instrument sees references at all (the resource core names
    // two docs; every skill names at least one) — an empty `dangling` on zero hits would
    // be silence, not conformance (testing.md § an INSTRUMENT is an assertion too).
    expect(hits).toBeGreaterThanOrEqual(6);
    expect(dangling).toEqual([]);
  });

  it('the resource core names the two docs by path, and the reserved .universe/ prefix is explained', () => {
    // The always-on core's job is to make the model READ the reference — so the pointers
    // must survive any edit of the platform file.
    expect(PLATFORM_AGENTS_MD).toContain('read `.platform/docs/resources.md`');
    expect(PLATFORM_AGENTS_MD).toContain('`.platform/docs/coding-your-ui.md`');
    expect(PLATFORM_AGENTS_MD).toContain('Resources are the only place user data lives');
    expect(PLATFORM_AGENTS_MD).toContain('`.universe/`');
  });
});
