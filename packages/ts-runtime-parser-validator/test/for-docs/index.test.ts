/**
 * For-docs tests backing website/docs/ts-runtime-parser-validator/index.md.
 * The landing page uses a flat `parse(value, typeName)` shape for the
 * quick-start teaser. This file provides a matching local `parse` helper
 * so the doc blocks substring-match.
 */

import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';

type ParseResult = {
  valid: boolean;
  data?: any;
  errors?: Array<{ path: string; expected: string; value?: unknown }>;
};

interface PrimaryStub {
  rpcParse: (
    typeDefinitions: string,
    typeName: string,
    value: unknown,
    bundleId?: string,
  ) => Promise<ParseResult>;
}

const TODO_TYPES = `
// todo.d.ts
interface Todo {
  title: string;
  done: boolean;
  /** @default 0 */
  priority?: number;
}
`;

// Flat `parse(value, typeName)` shape used on the landing page.
const parse = (value: unknown, typeName: string): Promise<ParseResult> => {
  const ns = env.PRIMARY_DO;
  const stub = ns.get(ns.idFromName('primary')) as unknown as PrimaryStub;
  return stub.rpcParse(TODO_TYPES, typeName, value, 'idx-default');
};

it('valid input comes back with defaults filled in', async () => {
  const ok = await parse({ title: 'Ship it', done: false }, 'Todo');
  expect(ok).toEqual({
    valid: true,
    data: { title: 'Ship it', done: false, priority: 0 },
  });
});

it('invalid input returns typia structured error list', async () => {
  const bad = await parse({ title: 42, done: 'not a boolean' }, 'Todo');
  expect(bad).toMatchObject({
    valid: false,
    errors: [
      { path: '$input.title', expected: 'string', value: 42 },
      { path: '$input.done', expected: 'boolean', value: 'not a boolean' },
    ],
  });
});
