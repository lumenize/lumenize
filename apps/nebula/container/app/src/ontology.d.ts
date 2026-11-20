/**
 * ontology.d.ts — the app's data model as TypeScript types (ADR-001: types ARE the
 * schema). A build that changes it compiles it to a runtime validator, and once that
 * build lands the `.dev` Star runs it; an edit here is an ordinary `writeSource` — the
 * ontology is just another source file. This baked starter is overwritten by the Galaxy's first-run
 * seed; the engine grows it during the cold-start interview.
 *
 * Annotations (@title/@description/@default/@inverse) are documented in
 * nebula-agentic-development-engine.md. Relationships are referenced by id (ADR-006).
 */

/** @title Item */
export interface Item {
  /** @title Title */
  title: string;
  /** @default false */
  done?: boolean;
}
