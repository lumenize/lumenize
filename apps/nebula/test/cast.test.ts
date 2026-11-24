/**
 * The cast an app's `docs/personas.md` names (`src/cast.ts`): which of the file's lines code reads.
 * A parser over text, so nothing here needs a running system. `persona-tabs` drives the read end
 * to end, from the file the Workspace holds to the tabs Studio shows.
 */
import { describe, it, expect } from 'vitest';
import { parseCast } from '../src/cast';

describe('parseCast', () => {
  it('reads each persona under The cast, in order, with the name up to its first full stop', () => {
    expect(parseCast(`# Personas

Some words about the cast.

## The cast

- \`mary\` — Mary Manager. Runs the account, and sees every deal.
- \`gerry\` — Gerry Salesperson. Works his own deals.
* \`sally\`: Sally Salesperson
- \`olga\`

## How to rebuild

1. From the me tab, invite \`pat\`.
`)).toEqual([
      { slug: 'mary', name: 'Mary Manager' },
      { slug: 'gerry', name: 'Gerry Salesperson' },
      { slug: 'sally', name: 'Sally Salesperson' },
      { slug: 'olga', name: '' },
    ]);
  });

  // Mutation: read list lines in every section, and `pat`, named in a step, becomes a tab.
  it('reads only the section headed The cast, at any heading level and in any case', () => {
    expect(parseCast('### the CAST\n- `mary` — Mary\n### Steps\n- `pat` — Pat\n')).toEqual([{ slug: 'mary', name: 'Mary' }]);
    expect(parseCast('- `mary` — Mary\n')).toEqual([]);
    expect(parseCast('## The cast of thousands\n- `mary` — Mary\n')).toEqual([]);
  });

  // Each slug becomes a host label, so only a persona slug counts. Mutations: drop the slug check,
  // and `Ed` and `evil.example` become tabs; drop the repeat check, and `mary` has two.
  it('skips a line that is no list item, a slug that is no persona slug, and a slug named again', () => {
    expect(parseCast([
      '## The cast',
      '`mary` — not a list item',
      '- mary — no backticks',
      '- `ed` — too short',
      '- `Mary` — capitals',
      '- `evil.example/x` — no slug at all',
      '- `mary` — Mary Manager.',
      '- `mary` — Mary again.',
      '- Write this when: the personas are named.',
    ].join('\n'))).toEqual([{ slug: 'mary', name: 'Mary Manager' }]);
  });

  it('names no cast for the seeded file, whose section holds only its prompt', () => {
    expect(parseCast('## The cast\n\nWrite this when: the personas are named. One line each.\n\n## Building the cast\n')).toEqual([]);
    expect(parseCast('')).toEqual([]);
  });
});
