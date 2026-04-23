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
import { generateParseModule } from '../src/generate-parse-module';
import { extractTypeMetadata } from '../src/extract-type-metadata';

describe('Benchmark — 30-resource-type ontology', () => {
  // Phase 6.5: two paths to measure.
  //   - `emittedEmbedded`: types fed as-written. Named-interface fields
  //     validate as embedded objects; typia inlines each target's full
  //     check recursively, so the module is much larger. This is the
  //     standalone-user path.
  //   - `emittedWriteShape`: ORM-composer path (Nebula). Caller pre-extracts
  //     and passes `writeShapeTypeDefinitions`, so named-interface fields
  //     become `string` IDs and validators stay small. This is the path
  //     Phase 6's 200 KB cap was measured against.
  const metadata = extractTypeMetadata(BENCHMARK_ONTOLOGY_30);
  const emittedEmbedded = generateParseModule(BENCHMARK_ONTOLOGY_30);
  const emittedWriteShape = generateParseModule(metadata.writeShapeTypeDefinitions);
  const emitted = emittedWriteShape; // kept for legacy references below

  it('compiles without errors in both modes', () => {
    for (const m of [emittedEmbedded, emittedWriteShape]) {
      expect(m).toContain('class ParserValidator extends DurableObject');
    }
  });

  it('extracts all 30 interfaces', () => {
    expect(metadata.interfaceNames.length).toBe(BENCHMARK_30_STATS.interfaceCount);
  });

  it('emits one validator IIFE per interface (both modes)', () => {
    for (const name of metadata.interfaceNames) {
      const re = new RegExp(`\\b${name}:\\s*\\(\\(\\)\\s*=>`);
      expect(emittedEmbedded).toMatch(re);
      expect(emittedWriteShape).toMatch(re);
    }
  });

  it('write-shape module size is within the dedup gate (200 KB); embedded is logged for reference', () => {
    const embBytes = emittedEmbedded.length;
    const wsBytes = emittedWriteShape.length;
    const kb = (b: number) => Math.round((b / 1024) * 10) / 10;
    console.log(
      `[bench] sizes — embedded: ${embBytes} B (${kb(embBytes)} KB), write-shape: ${wsBytes} B (${kb(wsBytes)} KB)`,
    );

    // The 200 KB gate from Phase 6 applies to the write-shape path (the
    // Nebula use case the benchmark was originally scoped to). Embedded-mode
    // size is documented but uncapped — standalone users with large type
    // graphs are expected to pay the nested-validator cost.
    expect(wsBytes).toBeLessThanOrEqual(200 * 1024);
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
