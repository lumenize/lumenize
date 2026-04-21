/**
 * Phase 6 benchmark — **size only**. In-Worker latency numbers require
 * Suite 2 (deployed, see `experiments/ts-runtime-parser-validator-spike/`)
 * because `performance.now()` inside `vitest-pool-workers` and on deployed
 * DOs returns the same value for both calls inside one synchronous turn.
 *
 * What this file measures:
 *   - Generated-module size for the 30-resource-type synthetic ontology
 *   - Structural sanity (all 30 interfaces produce validator entries)
 *   - The `200 KB` threshold from Phase 6's dedup gate
 */

import { describe, it, expect } from 'vitest';
import {
  BENCHMARK_ONTOLOGY_30,
  BENCHMARK_30_STATS,
} from './fixtures/benchmark-ontology-30';
import { compileTypesToParseModule } from '../src/compile-types-to-parse-module';
import { extractTypeMetadata } from '../src/extract-type-metadata';

describe('Benchmark — 30-resource-type ontology', () => {
  const emitted = compileTypesToParseModule(BENCHMARK_ONTOLOGY_30);
  const metadata = extractTypeMetadata(BENCHMARK_ONTOLOGY_30);

  it('compiles without errors', () => {
    expect(emitted).toContain('class ParserValidator extends DurableObject');
    expect(emitted).toContain('export default');
  });

  it('extracts all 30 interfaces', () => {
    expect(metadata.interfaceNames.length).toBe(BENCHMARK_30_STATS.interfaceCount);
  });

  it('emits one validator IIFE per interface', () => {
    for (const name of metadata.interfaceNames) {
      const re = new RegExp(`\\b${name}:\\s*\\(\\(\\)\\s*=>`);
      expect(emitted).toMatch(re);
    }
  });

  it('generated-module size is documented and within the dedup gate (200 KB)', () => {
    const sizeBytes = emitted.length;
    const sizeKB = Math.round((sizeBytes / 1024) * 10) / 10;
    console.log(`[bench] generated-module size: ${sizeBytes} bytes (${sizeKB} KB)`);

    // Hard upper bound — 200 KB is the Phase 6 dedup gate. If this ever
    // flips to failing, either the ontology grew or typia's emit got bigger
    // (post-upgrade). Either way, revisit the dedup-pass investigation.
    expect(sizeBytes).toBeLessThanOrEqual(200 * 1024);
  });

  it('size breakdown: shared boilerplate vs per-validator IIFEs', () => {
    // Shared boilerplate = the two inlined typia helpers + accessExpression
    // helper + ParserValidator class scaffolding.
    const helperPattern = /__typia_transform__\w+\s*=\s*\(\(\)\s*=>/g;
    const helperMatches = [...emitted.matchAll(helperPattern)];
    expect(helperMatches.length).toBeGreaterThanOrEqual(3);

    // Per-validator IIFEs: collect total bytes so we can see how dominant
    // they are vs fixed overhead.
    const iifeRe = /(\w+):\s*\(\(\)\s*=>\s*\{[\s\S]*?\}\)\(\)/g;
    let perValidatorBytes = 0;
    const iifeSizes: Record<string, number> = {};
    let m: RegExpExecArray | null;
    while ((m = iifeRe.exec(emitted)) !== null) {
      // Filter out the __typia_transform__ entries (those aren't per-validator).
      if (m[1].startsWith('__typia_transform__')) continue;
      perValidatorBytes += m[0].length;
      iifeSizes[m[1]] = m[0].length;
    }

    const minIife = Math.min(...Object.values(iifeSizes));
    const maxIife = Math.max(...Object.values(iifeSizes));
    const meanIife = Math.round(perValidatorBytes / Object.keys(iifeSizes).length);
    const fixedBytes = emitted.length - perValidatorBytes;

    console.log('[bench] size breakdown:', {
      totalBytes: emitted.length,
      fixedOverheadBytes: fixedBytes,
      perValidatorBytes,
      perValidatorCount: Object.keys(iifeSizes).length,
      iifeMinBytes: minIife,
      iifeMaxBytes: maxIife,
      iifeMeanBytes: meanIife,
    });

    expect(Object.keys(iifeSizes).length).toBe(BENCHMARK_30_STATS.interfaceCount);
  });

  it('relationship detection: captures the expected container shapes', () => {
    // Spot-check that the benchmark ontology exercises all the container
    // shapes (Array, Set, Map, one-to-one, nullable one).
    const rels = metadata.relationships;
    const allRels: Array<{ container?: string; cardinality: string }> = [];
    for (const typeName of Object.keys(rels)) {
      for (const field of Object.keys(rels[typeName])) {
        allRels.push(rels[typeName][field]);
      }
    }

    const containers = new Set(allRels.map((r) => r.container ?? 'direct'));
    expect(containers.has('array')).toBe(true);
    expect(containers.has('set')).toBe(true);
    expect(containers.has('map')).toBe(true);
    // "direct" covers both one-to-one and nullable-one.
    expect(containers.has('direct')).toBe(true);

    console.log(
      `[bench] relationships: ${allRels.length} across ${Object.keys(rels).length} types`,
      {
        cardinalityOne: allRels.filter((r) => r.cardinality === 'one').length,
        cardinalityMany: allRels.filter((r) => r.cardinality === 'many').length,
        containerBreakdown: Array.from(containers),
      },
    );
  });

  it('defaults: records every @default tag in the ontology', () => {
    const defaultFieldCount = Object.values(metadata.defaults).reduce(
      (acc, fields) => acc + Object.keys(fields).length,
      0,
    );
    console.log(
      `[bench] @default tags: ${defaultFieldCount} fields across ${Object.keys(metadata.defaults).length} types`,
    );
    expect(defaultFieldCount).toBeGreaterThan(5);
  });
});
