/**
 * LumenizeContainer literal-class wiring (Phase 2) — pure prototype + fetch-pin
 * tests that need no construction (so they're immune to the precheck's
 * can't-construct-under-pool-workers constraint).
 *
 * Together with container-seam.test.ts (the composed receive contract against a
 * DO harness), these lock the real class: m7 proves the narrow core left
 * Container's owned lifecycle untouched while adding exactly the mesh surface,
 * and the strip tests prove the M1 fetch() pin.
 *
 * @see tasks/nebula-devcontainer-node-type.md § Phase 2
 */
import { describe, it, expect } from 'vitest';
import { Container } from '@cloudflare/containers';
import { LumenizeContainer, stripContainerTargetPort } from '../../src/lumenize-container.js';

describe('m7: narrow core — Container lifecycle untouched, mesh surface added', () => {
  // `alarm`/`onStart` live on Container.prototype (one level up). The node
  // INHERITS them live (load-bearing for container lifecycle) and must NOT
  // override them. Identity (not !Object.hasOwn, which is vacuous here):
  it('does NOT override Container.prototype.alarm (inherits it live)', () => {
    expect(Object.hasOwn(LumenizeContainer.prototype, 'alarm')).toBe(false);
    expect(LumenizeContainer.prototype.alarm).toBe(Container.prototype.alarm);
  });

  it('does NOT override Container.prototype.onStart (inherits it live)', () => {
    expect(Object.hasOwn(LumenizeContainer.prototype, 'onStart')).toBe(false);
    expect(LumenizeContainer.prototype.onStart).toBe(Container.prototype.onStart);
  });

  // Positive own-prop control: the core DID add exactly the mesh surface.
  // Capable-of-failing: drop any member → its hasOwn flips false.
  it('adds the mesh receive surface as own properties', () => {
    for (const member of ['onBeforeCall', '__executeChain', '__executeOperation']) {
      expect(Object.hasOwn(LumenizeContainer.prototype, member)).toBe(true);
    }
    // Getters: present as own accessor descriptors.
    expect(Object.getOwnPropertyDescriptor(LumenizeContainer.prototype, 'lmz')?.get).toBeTypeOf('function');
    expect(
      Object.getOwnPropertyDescriptor(LumenizeContainer.prototype, '__localChainExecutor')?.get,
    ).toBeTypeOf('function');
  });

  // M1: fetch IS overridden (own + distinct from the base) so the port pin runs.
  it('overrides Container.prototype.fetch (the M1 public-port pin)', () => {
    expect(Object.hasOwn(LumenizeContainer.prototype, 'fetch')).toBe(true);
    expect(LumenizeContainer.prototype.fetch).not.toBe(Container.prototype.fetch);
  });
});

describe('M1: fetch() public-port pin (stripContainerTargetPort)', () => {
  it('strips an inbound cf-container-target-port header', () => {
    const req = new Request('https://preview.example/app', {
      headers: { 'cf-container-target-port': '9000', 'x-keep': 'yes' },
    });
    const out = stripContainerTargetPort(req);
    // Capable-of-failing: revert the strip → this header survives.
    expect(out.headers.has('cf-container-target-port')).toBe(false);
    // Unrelated headers are preserved.
    expect(out.headers.get('x-keep')).toBe('yes');
    // The original request is not mutated.
    expect(req.headers.get('cf-container-target-port')).toBe('9000');
  });

  it('is a no-op when the header is absent (returns the same request)', () => {
    const req = new Request('https://preview.example/app');
    expect(stripContainerTargetPort(req)).toBe(req);
  });
});
