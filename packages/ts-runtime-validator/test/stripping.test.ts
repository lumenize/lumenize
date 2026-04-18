/**
 * Export/import stripping edge cases for stripExportsAndImports().
 */

import { describe, it, expect } from 'vitest';
import { stripExportsAndImports } from '../src/validate';

describe('stripExportsAndImports', () => {
  it('strips export before interface', () => {
    const input = 'export interface Foo { title: string; }';
    expect(stripExportsAndImports(input)).toBe('interface Foo { title: string; }');
  });

  it('strips export before type', () => {
    const input = 'export type Bar = string;';
    expect(stripExportsAndImports(input)).toBe('type Bar = string;');
  });

  it('strips export before enum', () => {
    const input = 'export enum Status { Active, Inactive }';
    expect(stripExportsAndImports(input)).toBe('enum Status { Active, Inactive }');
  });

  it('strips export before class', () => {
    const input = 'export class MyClass {}';
    expect(stripExportsAndImports(input)).toBe('class MyClass {}');
  });

  it('strips export before const', () => {
    const input = 'export const MAX_RETRIES = 3;';
    expect(stripExportsAndImports(input)).toBe('const MAX_RETRIES = 3;');
  });

  it('strips export before let', () => {
    const input = 'export let counter: number;';
    expect(stripExportsAndImports(input)).toBe('let counter: number;');
  });

  it('strips export before var', () => {
    const input = 'export var legacy: string;';
    expect(stripExportsAndImports(input)).toBe('var legacy: string;');
  });

  it('strips export before function', () => {
    const input = 'export function foo(): void {}';
    expect(stripExportsAndImports(input)).toBe('function foo(): void {}');
  });

  it('strips export before async function', () => {
    const input = 'export async function fetch(): Promise<void> {}';
    expect(stripExportsAndImports(input)).toBe('async function fetch(): Promise<void> {}');
  });

  it('strips export before declare', () => {
    const input = 'export declare function foo(): void;';
    expect(stripExportsAndImports(input)).toBe('declare function foo(): void;');
  });

  it('strips export before abstract', () => {
    const input = 'export abstract class Base {}';
    expect(stripExportsAndImports(input)).toBe('abstract class Base {}');
  });

  it('removes import lines', () => {
    const input = `import { Baz } from './other';
interface Foo { baz: Baz; }`;
    expect(stripExportsAndImports(input)).toBe(`
interface Foo { baz: Baz; }`);
  });

  it('removes import type lines', () => {
    const input = `import type { Config } from './config';
interface Foo { config: Config; }`;
    expect(stripExportsAndImports(input)).toBe(`
interface Foo { config: Config; }`);
  });

  it('removes re-export lines', () => {
    const input = `export { Foo, Bar };`;
    expect(stripExportsAndImports(input)).toBe('');
  });

  it('removes re-export from lines', () => {
    const input = `export { Foo } from './module';`;
    expect(stripExportsAndImports(input)).toBe('');
  });

  it('removes export default lines', () => {
    const input = `export default class MyClass {}`;
    expect(stripExportsAndImports(input)).toBe('');
  });

  it('leaves plain interface unchanged', () => {
    const input = 'interface Foo { title: string; }';
    expect(stripExportsAndImports(input)).toBe('interface Foo { title: string; }');
  });

  it('preserves indentation when stripping export', () => {
    const input = '  export interface Foo { title: string; }';
    expect(stripExportsAndImports(input)).toBe('  interface Foo { title: string; }');
  });

  it('handles multi-line input with mixed exports and plain declarations', () => {
    const input = `import { Something } from './thing';
export interface Todo { title: string; done: boolean; }
export type Status = 'active' | 'done';
interface Internal { id: number; }
export { Todo, Status };`;
    const expected = `
interface Todo { title: string; done: boolean; }
type Status = 'active' | 'done';
interface Internal { id: number; }
`;
    expect(stripExportsAndImports(input)).toBe(expected);
  });

  it('handles empty input', () => {
    expect(stripExportsAndImports('')).toBe('');
  });

  it('handles input with only whitespace lines', () => {
    expect(stripExportsAndImports('  \n  \n')).toBe('  \n  \n');
  });
});
