/**
 * End-to-end test for the getting-started.md narrative.
 *
 * Walks through the three-step flow: generateParseModule → mount via
 * SupervisorDO → call parse() on valid and invalid inputs. Doc's code
 * blocks substring-match against this file (+ index.ts, schema.d.ts).
 */

import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { generateParseModule } from '../../../src/generate-parse-module';
import schemaTypes from './schema.d.ts?raw';

type ParseResult =
  | { valid: true; data: unknown }
  | { valid: false; errors: Array<{ path: string; expected: string; value: unknown; description?: string }> };

interface SupervisorStub {
  parse: (
    bundleId: string,
    value: unknown,
    typeName: string,
  ) => Promise<ParseResult>;
  registerModuleSource: (bundleId: string, moduleSource: string) => void;
}

function getSupervisor(): SupervisorStub {
  const ns = env.SUPERVISOR;
  return ns.get(ns.idFromName('getting-started')) as unknown as SupervisorStub;
}

it('Step 1 — generateParseModule produces a non-empty module string', () => {
  const moduleSource = generateParseModule(schemaTypes);
  expect(typeof moduleSource).toBe('string');
  expect(moduleSource.length).toBeGreaterThan(0);
});

it('Step 3 — parse() on valid input fills @default values', async () => {
  const supervisor = getSupervisor();
  const bundleId = 'getting-started-valid';
  const moduleSource = generateParseModule(schemaTypes);
  await supervisor.registerModuleSource(bundleId, moduleSource);

  const ok = await supervisor.parse(bundleId, {
    name: 'Alice',
    home: { street: '1 Main', city: 'Springfield' },
  }, 'User');
  expect(ok).toEqual({
    valid: true,
    data: {
      name: 'Alice',
      home: { street: '1 Main', city: 'Springfield', country: 'US' },
    },
  });
});

it('Step 3 — parse() on invalid input returns structured errors', async () => {
  const supervisor = getSupervisor();
  const bundleId = 'getting-started-invalid';
  const moduleSource = generateParseModule(schemaTypes);
  await supervisor.registerModuleSource(bundleId, moduleSource);

  const bad = await supervisor.parse(bundleId, {
    name: 42,
    home: { street: '1 Main', city: 'Springfield' },
  }, 'User');
  expect(bad).toMatchObject({
    valid: false,
    errors: [
      { path: '$input.name', expected: 'string', value: 42 },
    ],
  });
});
