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

describe('extractTypeMetadata().fields: @deprecatedValues', () => {
  const types = (tag: string, type = `'lead' | 'qualified' | 'open' | 'stalled' | 'won'`) => `
interface Deal {
  /**
   * ${tag}
   */
  stage: ${type};
  address: {
    /**
     * @deprecatedValues po-box
     */
    kind: 'street' | 'po-box';
  };
  plain: 'a' | 'b';
}`;

  it('records the deprecated values in declared order, keeps every value, and reaches a nested field', () => {
    const { fields } = extractTypeMetadata(types('@deprecatedValues stalled, qualified'));
    expect(fields.Deal!.stage).toEqual({
      kind: 'enum', values: ['lead', 'qualified', 'open', 'stalled', 'won'], deprecated: ['qualified', 'stalled'], optional: false,
    });
    expect((fields.Deal!.address as any).fields.kind).toEqual({ kind: 'enum', values: ['street', 'po-box'], deprecated: ['po-box'], optional: false });
    expect(fields.Deal!.plain).toEqual({ kind: 'enum', values: ['a', 'b'], optional: false });
  });

  it.each<[string, string, string | undefined, string]>([
    ['a value the field does not hold', '@deprecatedValues closed', undefined,
      '@deprecatedValues on Deal.stage names "closed", and the field\'s values are "lead", "qualified", "open", "stalled", "won"'],
    ['a value named twice', '@deprecatedValues stalled, stalled', undefined, '@deprecatedValues on Deal.stage names "stalled" twice'],
    ['no values', '@deprecatedValues', undefined, '@deprecatedValues on Deal.stage names no values'],
    ['two tags on one field', '@deprecatedValues stalled\n   * @deprecatedValues qualified', undefined, '@deprecatedValues on Deal.stage is written twice'],
    ['a field that is not a list of string values', '@deprecatedValues stalled', 'string',
      '@deprecatedValues on Deal.stage needs a field whose type is a list of string values'],
  ])('refuses %s', (_name, tag, type, message) => {
    expect(() => extractTypeMetadata(types(tag, type))).toThrow(message);
  });

  it('refuses a tag TypeScript attached to nothing, by the count written against the count read', () => {
    expect(() => extractTypeMetadata(`interface Deal { /** @deprecatedValues a */ stage: 'a' | 'b'; }`))
      .toThrow('1 @deprecatedValues tags are written and 0 were read');
  });
});

describe('extractTypeMetadata().indexes', () => {
  const declared = (types: string) => extractTypeMetadata(types).indexes;
  const refusal = (types: string): string => {
    try { extractTypeMetadata(types); } catch (e) { return (e as Error).message; }
    return 'extracted';
  };

  it('reads @index on a field, on a nested field, and over several fields on the interface', () => {
    expect(declared(`
      interface Person { name: string; }
      /**
       * A deal.
       * @index stage, amount
       * @index due
       */
      interface Deal {
        /** @index */
        owner: Person;
        stage: 'lead' | 'open';
        amount?: number;
        due?: Date;
        address?: {
          /** @index */
          city: string;
        } | null;
      }
      interface Task {
        /** The title. @index */
        title: string;
      }
    `)).toEqual([
      { type: 'Deal', fields: ['stage', 'amount'] },
      { type: 'Deal', fields: ['due'] },
      { type: 'Deal', fields: ['owner'] },
      { type: 'Deal', fields: ['address.city'] },
      { type: 'Task', fields: ['title'] },
    ]);
  });

  it('declares none where no @index is written, and keeps a type-level index on its own type', () => {
    expect(declared('interface A { a: string; }')).toEqual([]);
    expect(declared('/** @index a */ interface A { a: string; }\ninterface B { a: string; }')).toEqual([{ type: 'A', fields: ['a'] }]);
  });

  it.each<[string, string, string]>([
    ['a field the type lacks', '/** @index nope */ interface A { a: string; }', '@index on A names "nope", and A has no such field'],
    ['a path past an object', '/** @index o.x */ interface A { o: { y: string }; }', '@index on A names "o.x", and A has no such field'],
    ['an object', '/** @index o */ interface A { o: { y: string }; }', '@index on A names "o", which holds an object'],
    ['an array', 'interface A {\n/** @index */\ntags: string[]; }', '@index on A names "tags", which a query cannot compare: it is an array'],
    ['a field twice in one index', '/** @index a, a */ interface A { a: string; }', '@index on A names "a" twice'],
    ['one index twice', '/** @index a */ interface A {\n/** @index */\na: string; }', '@index on A declares the index on "a" twice'],
    ['no fields on an interface', '/** @index */ interface A { a: string; }', '@index on A names no fields'],
    ['text on a field', 'interface A {\n/** @index a, b */\na: string; b: string; }', '@index on A field "a" takes no text'],
    ['a tag TypeScript attaches to nothing', 'interface A { /** @index */ a: string; }', '1 @index tags are written and 0 were read'],
    ['a tag after a field on its line', 'interface A {\n b: number; /** @index */ a: string; }', '1 @index tags are written and 0 were read'],
  ])('refuses %s', (_name, types, message) => {
    expect(refusal(types)).toContain(message);
  });
});
