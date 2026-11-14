/**
 * The ontology the query tests share, compiled by the real extractor so the engine is driven by
 * the field model production hands it.
 */
import { extractTypeMetadata } from '@lumenize/ts-runtime-parser-validator/compile';
import type { FieldsMap } from '../../src/query';

export const TYPES = `
type Stage = 'lead' | 'open' | 'won';
interface Person { name: string; }
interface Deal {
  title: string;
  stage: Stage;
  amount?: number;
  budget?: number | null;
  won: boolean;
  due?: Date;
  owner: Person;
  note?: string;
  address?: { city: string; geo?: { lat: number } };
  tags?: string[];
  scores?: Map<string, number>;
  big?: bigint;
}
interface Task { title: string; stage: Stage; }
`;

let cached: FieldsMap | undefined;
export function fields(): FieldsMap {
  return (cached ??= extractTypeMetadata(TYPES).fields);
}
