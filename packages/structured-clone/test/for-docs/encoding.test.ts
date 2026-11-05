/**
 * Examples for website/docs/structured-clone/index.mdx § The Encoding.
 *
 * The codec is a pure function of its input, so these need no running system.
 */

import { describe, it, expect } from 'vitest';
import { stringify, preprocess, postprocess, diff, applyMergePatch } from '../../src/index.js';

describe('The Encoding', () => {
  it('writes each value in a form a merge patch can address', () => {
    expect(stringify({ title: 'Ship it' })).toBe('{"title":"Ship it"}');
    expect(stringify(new Map([['pro', 25]]))).toBe('{"$type":"map","object":{"pro":25}}');
    expect(stringify(new Set(['a', 'b']))).toBe('{"$type":"set","object":{"a":1,"b":1}}');
    expect(stringify({ b: null })).toBe('{"b":{"$type":"null"}}');
    expect(stringify(new Uint8Array([1, 2, 3]))).toBe('{"$type":"arraybuffer","subtype":"Uint8Array","base64":"AQID"}');

    const owner = { name: 'Alice' };
    expect(stringify({ owner, reviewer: owner })).toBe('{"owner":{"name":"Alice"},"reviewer":{"$ref":"#/owner"}}');
  });

  it('patches a stored value one change at a time', () => {
    const before = preprocess({ title: 'Ship it', tags: new Map([['urgent', true]]) });
    const after = preprocess({ title: 'Ship it', tags: new Map([['urgent', true], ['q4', true]]) });

    const answer = diff(before, after);
    expect(answer).toEqual({ kind: 'patches', patches: [{ tags: { object: { q4: true } } }] });

    const patched = answer.kind === 'patches'
      ? answer.patches.reduce((target, patch) => applyMergePatch(target, patch), before)
      : after;
    expect([...postprocess(patched).tags.keys()]).toEqual(['urgent', 'q4']);
  });
});
