/**
 * `extractTypeMetadata().fields`: what a query may filter and index on, read from each field's
 * declared type. Pure AST work, so it needs no running system.
 */
import { describe, it, expect } from 'vitest';
import { extractTypeMetadata } from '../src/extract-type-metadata';

const TYPES = `
type Stage = 'open' | 'lead' | 'won';
type Tags = string[];
interface Person { name: string; }
interface Deal {
  title: string;
  amount: number;
  won: boolean;
  due?: Date;
  owner: Person;
  backup: Person | null;
  stage: Stage;
  priority?: 'low' | 'high' | null;
  only: 'fixed';
  address: { city: string; geo?: { lat: number } };
  note: string | undefined;
  watchers: Person[];
  tags: Tags;
  labels: Set<string>;
  scores: Map<string, number>;
  big: bigint;
  mixed: string | number;
  flag: true | false;
  count: (number);
  other: Unknown;
}
type Opportunity = Deal;
`;

describe('extractTypeMetadata().fields', () => {
  const { fields } = extractTypeMetadata(TYPES);

  it('reads each scalar a query can compare', () => {
    expect(fields.Deal!.title).toEqual({ kind: 'string', optional: false });
    expect(fields.Deal!.amount).toEqual({ kind: 'number', optional: false });
    expect(fields.Deal!.won).toEqual({ kind: 'boolean', optional: false });
    expect(fields.Deal!.due).toEqual({ kind: 'date', optional: true });
    expect(fields.Deal!.count).toEqual({ kind: 'number', optional: false });
    expect(fields.Deal!.flag).toEqual({ kind: 'boolean', optional: false });
  });

  it('reads a to-one relationship as an id, and a nullable one as nullable', () => {
    expect(fields.Deal!.owner).toEqual({ kind: 'id', target: 'Person', optional: false });
    expect(fields.Deal!.backup).toEqual({ kind: 'id', target: 'Person', nullable: true, optional: false });
    expect(fields.Deal!.note).toEqual({ kind: 'string', nullable: true, optional: false });
  });

  it('reads a union of string literals as an enum in declared order, through an alias', () => {
    expect(fields.Deal!.stage).toEqual({ kind: 'enum', values: ['open', 'lead', 'won'], optional: false });
    expect(fields.Deal!.priority).toEqual({ kind: 'enum', values: ['low', 'high'], nullable: true, optional: true });
    expect(fields.Deal!.only).toEqual({ kind: 'enum', values: ['fixed'], optional: false });
  });

  it('reads an inline object with its own fields', () => {
    expect(fields.Deal!.address).toEqual({
      kind: 'object', optional: false,
      fields: {
        city: { kind: 'string', optional: false },
        geo: { kind: 'object', optional: true, fields: { lat: { kind: 'number', optional: false } } },
      },
    });
  });

  it('names what it cannot query, in the words a refusal uses', () => {
    const reason = (name: string) => (fields.Deal![name] as { kind: string; reason?: string });
    expect(reason('watchers')).toMatchObject({ kind: 'unsupported', reason: 'an array' });
    expect(reason('tags')).toMatchObject({ kind: 'unsupported', reason: 'an array' });
    expect(reason('labels')).toMatchObject({ kind: 'unsupported', reason: 'a Set' });
    expect(reason('scores')).toMatchObject({ kind: 'unsupported', reason: 'a Map' });
    expect(reason('big')).toMatchObject({ kind: 'unsupported', reason: 'a bigint' });
    expect(reason('mixed')).toMatchObject({ kind: 'unsupported', reason: 'a union of different types' });
    expect(reason('other')).toMatchObject({ kind: 'unsupported', reason: 'the type Unknown' });
  });

  it('gives an alias of an interface that interface\'s fields, and lists every interface', () => {
    expect(fields.Opportunity).toBe(fields.Deal);
    expect(Object.keys(fields).sort()).toEqual(['Deal', 'Opportunity', 'Person']);
    expect(fields.Person).toEqual({ name: { kind: 'string', optional: false } });
  });
});
