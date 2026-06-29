/**
 * DevStudio Session/Turn ontology — compile-level + bundle-id unit checks
 * (Child 1, nebula-devstudio-data-plane.md Phase 2).
 *
 * The embed-guard *mechanism* (loud error for an object in a relationship field)
 * is owned + covered by `@lumenize/ts-runtime-parser-validator`
 * (`relationship-write-shape.test.ts`). Here we pin the two things specific to
 * THIS ontology that don't need a composed DevStudio DO:
 *   1. `Turn.session` is authored as a real to-one relationship to `Session`
 *      (so the write-shape rewrite + ADR-006 embed-guard actually apply to it).
 *   2. the Worker-Loader bundle id is disjoint from every other namespace
 *      (review M2 — a collision is a silent validation bypass).
 *
 * The facet-mount integration checks (embed-guard firing, both-facets-in-one-DO,
 * wipe/onStart recovery) run against the composed DevStudio in Phase 3.
 */
import { describe, it, expect } from 'vitest';
import { compileOntologyVersion, SESSION_TURN_TYPES, SESSION_TURN_ONTOLOGY_VERSION, SESSION_TURN_BUNDLE_ID } from '@lumenize/nebula';
import { TOOL_ARGS_BUNDLE_ID } from '../src/codegen-loop';

describe('devstudio Session/Turn ontology', () => {
  it('authors Turn.session as a to-one relationship to Session (write-shape + ADR-006 embed-guard apply)', () => {
    const row = compileOntologyVersion({
      version: SESSION_TURN_ONTOLOGY_VERSION,
      types: SESSION_TURN_TYPES,
    });
    // The relationships map is what threads into generateParseModule → the loud
    // embed-guard. If `session` were authored as a bare `string` (not `Session`),
    // there'd be no relationship here and the embed-guard would silently vanish.
    expect(row.relationships.Turn?.session).toMatchObject({
      target: 'Session',
      cardinality: 'one',
    });
  });

  it('bundle id is disjoint from the tool-args id and from Star\'s {galaxyId}/{version} form (review M2)', () => {
    // Distinct from the other DevStudio facet.
    expect(SESSION_TURN_BUNDLE_ID).not.toBe(TOOL_ARGS_BUNDLE_ID);
    // Structurally cannot collide with a Star bundle id, whose form is
    // `{universe}.{galaxy}/{version}` — its pre-`/` segment ALWAYS contains a `.`;
    // this one's must NOT (so no galaxyId can ever equal it).
    const preSlash = SESSION_TURN_BUNDLE_ID.split('/')[0];
    expect(preSlash).not.toContain('.');
  });
});
