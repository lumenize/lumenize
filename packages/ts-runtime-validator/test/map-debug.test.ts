import { describe, it, expect } from 'vitest';
import { validate } from '../src/validate';
import { toTypeScript } from '../src/to-typescript';

describe('Map emit debug', () => {
  it('shows emitted code for heterogeneous map', () => {
    const code = toTypeScript({ data: new Map([['a', 1], ['b', 'hello']]) }, 'C');
    console.log('EMITTED:', code);
  });

  it('shows emitted code for wrong-type map', () => {
    const code = toTypeScript({ data: new Map([['a', 'not-a-number']]) }, 'C');
    console.log('EMITTED:', code);
  });
});
