/**
 * Write-shape relationship behavior + the loud-warning enrichment.
 *
 * Nebula validates resource writes against the *write shape*: a field whose
 * type is another ontology interface is a RELATIONSHIP, rewritten to a by-id
 * `string` / `string[]` (see `extractTypeMetadata().writeShapeTypeDefinitions`).
 * These tests pin two things:
 *   1. What's representable — relationship cycles/aliases (by id) and plain-data
 *      cycles/aliases inside loosely-typed value fields all validate; embedding
 *      an object where an id belongs does not.
 *   2. The loud warning — when someone embeds an object/array in a relationship
 *      field (what a misconceived "cyclic value" test did), the error explains
 *      the by-id contract instead of the opaque "expected (string | undefined)".
 *
 * `parseWriteShape` runs the exact path `Galaxy.compileOntologyVersion()` uses
 * (raw types → extractTypeMetadata → generateParseModule(writeShape, rels)).
 */
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

type ParseResult = {
  valid: boolean;
  data?: unknown;
  errors?: Array<{ path: string; expected: string; value?: unknown; description?: string }>;
};
interface PrimaryStub {
  parseWriteShape: (rawTypes: string, typeName: string, value: unknown, bundleId?: string) => Promise<ParseResult>;
}
function parseWS(rawTypes: string, typeName: string, value: unknown, bundleId: string): Promise<ParseResult> {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.parseWriteShape(rawTypes, typeName, value, bundleId);
}

const REF = `interface R { label: string; self?: R }`;
const NODE = `interface Node { label: string; children?: Node[] }`;

describe('write-shape relationships: representable cycles/aliases', () => {
  it('a single relationship reference is satisfied by an id string', async () => {
    const r = await parseWS(REF, 'R', { label: 'x', self: 'other-resource-id' }, 'ws-id');
    expect(r.valid).toBe(true);
  });

  it('an omitted optional relationship is fine', async () => {
    const r = await parseWS(REF, 'R', { label: 'x' }, 'ws-absent');
    expect(r.valid).toBe(true);
  });

  it('a relationship CYCLE is representable by id (a resource referencing its own id)', async () => {
    const r = await parseWS(REF, 'R', { label: 'x', self: 'r-self-id' }, 'ws-cycle-byid');
    expect(r.valid).toBe(true);
  });

  it('a relationship ALIAS (DAG) is representable by id (same id referenced twice)', async () => {
    const r = await parseWS(NODE, 'Node', { label: 'root', children: ['shared-id', 'shared-id'] }, 'ws-alias-byid');
    expect(r.valid).toBe(true);
  });

  it('a to-many relationship is satisfied by an array of id strings', async () => {
    const r = await parseWS(NODE, 'Node', { label: 'root', children: ['a', 'b', 'c'] }, 'ws-many-ids');
    expect(r.valid).toBe(true);
  });

  it('a plain-data CYCLE inside a loosely-typed value field validates (round-trips)', async () => {
    const types = `interface Doc { title: string; blob: unknown }`;
    const blob: any = { k: 1 };
    blob.self = blob; // structured-clone cycle in a non-relationship value field
    const r = await parseWS(types, 'Doc', { title: 't', blob }, 'ws-value-cycle');
    expect(r.valid).toBe(true);
  });

  it('a plain-data ALIAS inside a loosely-typed value field validates', async () => {
    const types = `interface Doc { title: string; blob: unknown }`;
    const shared = { v: 9 };
    const r = await parseWS(types, 'Doc', { title: 't', blob: { a: shared, b: shared } }, 'ws-value-alias');
    expect(r.valid).toBe(true);
  });
});

describe('write-shape relationships: loud warning on embedded objects', () => {
  it('embedding an object in a single relationship field is rejected with a relationship-aware message', async () => {
    const cyclic: any = { label: 'x' };
    cyclic.self = cyclic; // the misconceived "cyclic value" — an embedded object, not an id
    const r = await parseWS(REF, 'R', cyclic, 'ws-embed-obj');

    expect(r.valid).toBe(false);
    const err = r.errors!.find((e) => e.path === '$input.self');
    expect(err).toBeDefined();
    // The loud warning: explains the by-id contract, names the field + target.
    expect(err!.description).toMatch(/relationship/i);
    expect(err!.description).toContain("'self'");
    expect(err!.description).toContain("'R'");
    expect(err!.description).toMatch(/reference by id/i);
  });

  it('a non-cyclic nested object in a relationship field is rejected the same way (it is not cycle-specific)', async () => {
    const r = await parseWS(REF, 'R', { label: 'x', self: { label: 'nested' } }, 'ws-embed-nested');
    expect(r.valid).toBe(false);
    const err = r.errors!.find((e) => e.path === '$input.self');
    expect(err!.description).toMatch(/relationship/i);
  });

  it('embedding an object in a to-many relationship element is rejected with a relationship-aware message', async () => {
    const r = await parseWS(NODE, 'Node', { label: 'root', children: [{ label: 'embedded' }] }, 'ws-embed-array');
    expect(r.valid).toBe(false);
    const err = r.errors!.find((e) => e.path.startsWith('$input.children'));
    expect(err).toBeDefined();
    expect(err!.description).toMatch(/relationship/i);
    expect(err!.description).toContain("'Node'");
    expect(err!.description).toMatch(/array of/i);
  });

  it('a plain string-typed field is NOT mislabeled a relationship (enrichment is relationship-scoped)', async () => {
    // `label` is a real string field, not a relationship — an object there
    // should still fail, but WITHOUT the relationship-by-id message.
    const r = await parseWS(REF, 'R', { label: { not: 'a string' } }, 'ws-plain-string');
    expect(r.valid).toBe(false);
    const err = r.errors!.find((e) => e.path === '$input.label');
    expect(err).toBeDefined();
    expect(err!.description ?? '').not.toMatch(/relationship/i);
  });
});
