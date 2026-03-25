/**
 * Pedagogical examples for the overview (index.mdx) documentation page.
 * Clear, minimal examples showing the core value proposition.
 */

import { describe, it, expect } from 'vitest';
import { validate, toTypeScript } from '@lumenize/ts-runtime-validator';
import todoTypes from './todo.d.ts?raw';

describe('Quick Start', () => {
  it('validates a value against a TypeScript interface', () => {
    const todo = { title: 'Ship it', done: false };

    const result = validate(todo, 'Todo', todoTypes);

    expect(result.valid).toBe(true);
  });

  it('catches type errors with real tsc diagnostics', () => {
    const bad = { title: 42, done: 'not a boolean' };

    const result = validate(bad, 'Todo', todoTypes);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].message)
        .toBe("Type 'number' is not assignable to type 'string'. → title: 42");
      expect(result.errors[1].message)
        .toBe("Type 'string' is not assignable to type 'boolean'. → done: \"not a boolean\"");
    }
  });

  it('detects missing properties', () => {
    const incomplete = { title: 'Ship it' };

    const result = validate(incomplete, 'Todo', todoTypes);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].property).toBe('done');
    }
  });

  it('detects excess properties', () => {
    const extra = { title: 'Ship it', done: false, priority: 1 };

    const result = validate(extra, 'Todo', todoTypes);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0].property).toBe('priority');
    }
  });
});

describe('How It Works', () => {
  it('toTypeScript serializes a value to a TypeScript program', () => {
    const todo = { title: 'Ship it', done: false };

    const program = toTypeScript(todo, 'Todo');

    expect(program).toBe(
      'const __validate: Todo = {\n  title: "Ship it",\n  done: false,\n};'
    );
  });

  it('validate runs that program through the real tsc compiler', () => {
    const todo = { title: 'Ship it', done: false };
    const result = validate(todo, 'Todo', todoTypes);

    // tsc sees: const __validate: Todo = {title: "Ship it", done: false};
    // Against:  interface Todo { title: string; done: boolean; }
    // No errors → valid
    expect(result).toEqual({ valid: true });
  });
});

describe('Rich Types', () => {
  it('validates Maps, Sets, and Dates', () => {
    const types = `
interface UserProfile {
  name: string;
  tags: Set<string>;
  preferences: Map<string, string>;
  createdAt: Date;
}
`;
    const profile = {
      name: 'Alice',
      tags: new Set(['admin', 'active']),
      preferences: new Map([['theme', 'dark'], ['lang', 'en']]),
      createdAt: new Date('2025-01-01'),
    };

    const result = validate(profile, 'UserProfile', types);
    expect(result.valid).toBe(true);
  });
});
