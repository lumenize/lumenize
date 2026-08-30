/**
 * The platform Chat/Message ontology — compile-level unit checks.
 *
 * The embed-guard *mechanism* (loud error for an object in a relationship field)
 * is owned + covered by `@lumenize/ts-runtime-parser-validator`
 * (`relationship-write-shape.test.ts`). Here we pin the things specific to THIS
 * ontology that don't need a composed Galaxy DO:
 *   1. `Message.chat` and `Message.replyTo` are authored as real to-one
 *      relationships (so the write-shape rewrite + ADR-006 embed-guard apply);
 *   2. `codegen` EMBEDS as a value object — never rewritten to a by-id ref (the
 *      inline-literal vehicle the collapse task's build-check demanded confirming);
 *   3. the deleted identity fields stay deleted — the type declares no `role` and
 *      no `author`, so display can only derive from the stamped `actingToken`.
 *
 * (The former hand-bumped `SESSION_MESSAGE_BUNDLE_ID` is DELETED: the loader
 * bundle id now derives from the INSTALLED version label — `{u}.{g}/chat/{label}`,
 * structurally disjoint from the one-slash app form — so staleness is solved by
 * derivation, not discipline; galaxy-resource-surface.test.ts covers the mount.)
 */
import { describe, it, expect } from 'vitest';
import { CHAT_MESSAGE_TYPES, CHAT_MESSAGE_ONTOLOGY_VERSION } from '@lumenize/nebula';
// The compile fn left the barrel with the Worker's compilers — imported from the leaf
// (a test lane may compile; the deployed Worker never does).
import { compileOntologyVersion } from '../src/ontology-compile';

describe('platform Chat/Message ontology', () => {
  const row = compileOntologyVersion({
    version: CHAT_MESSAGE_ONTOLOGY_VERSION,
    types: CHAT_MESSAGE_TYPES,
  });

  it('authors Message.chat as a to-one relationship to Chat (write-shape + ADR-006 embed-guard apply)', () => {
    // The relationships map is what threads into generateParseModule → the loud
    // embed-guard. If `chat` were authored as a bare `string` (not `Chat`),
    // there'd be no relationship here and the embed-guard would silently vanish.
    expect(row.relationships.Message?.chat).toMatchObject({
      target: 'Chat',
      cardinality: 'one',
    });
  });

  it('authors Message.replyTo as an optional to-one self-relationship (the corpus prompt→reply link)', () => {
    expect(row.relationships.Message?.replyTo).toMatchObject({
      target: 'Message',
      cardinality: 'one',
      optional: true,
    });
  });

  it('codegen EMBEDS as a value object — no relationship entry, and the write shape keeps the literal', () => {
    // Capable-of-failing: if `codegen` were authored as a named interface, the compiler
    // would treat it as an ontology type — a relationship entry would appear here and the
    // write shape would carry `codegen?: string`, flattening the corpus to a ref with
    // nothing to reference.
    expect(row.relationships.Message?.codegen).toBeUndefined();
    const md = row.types;
    expect(md).toContain('codegen?: {');
    expect(md).toContain('appliedPaths: string[]');
  });

  it('declares NO role and NO author — display derives only from the stamped actingToken', () => {
    // The discriminator: the OLD type carried `role: string` and `author?: string`; the
    // bare words appear nowhere in the new source (`; role:` / `author?:` shapes).
    expect(CHAT_MESSAGE_TYPES).not.toMatch(/\brole\??:/);
    expect(CHAT_MESSAGE_TYPES).not.toMatch(/\bauthor\??:/);
  });
});
