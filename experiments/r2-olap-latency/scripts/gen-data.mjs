#!/usr/bin/env node
/**
 * Deterministic resource-history row generator for the R2-OLAP-latency spike.
 *
 * No Math.random / Date.now (CF clock traps + reproducibility): every field is seeded
 * by row index, so re-running produces byte-identical output. Emits NDJSON (one JSON row
 * per line) → loadable into both DO SQLite (arm 1 seed) and Iceberg (arm 2, via PyIceberg).
 *
 * Usage: node scripts/gen-data.mjs [count] [outfile]
 *   node scripts/gen-data.mjs 5000
 *   node scripts/gen-data.mjs 1000000 data/rows-1M.ndjson
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const COUNT = parseInt(process.argv[2] || '5000', 10)
const OUT = process.argv[3] || `data/rows-${COUNT}.ndjson`

const TYPES = ['Todo', 'Project', 'Comment', 'User', 'Tag']
const TENANTS = 8
const BASE_MS = Date.parse('2026-01-01T00:00:00Z') // constant from a literal — not "now"
const STEP_MS = 60_000 // 1 minute between versions
const END_OF_TIME = 8640000000000000 // ADR-004 "current" sentinel (max valid Date ms)
const RESOURCES = Math.max(1, Math.floor(COUNT / 6)) // ~6 versions per resource on average

function row(i) {
  const type = TYPES[i % TYPES.length]
  const resourceIdx = i % RESOURCES
  const resourceId = `${type.toLowerCase()}-${resourceIdx}`
  const version = Math.floor(i / RESOURCES) // 0,1,2,... per resource
  const validFrom = BASE_MS + (resourceIdx * 17 + version) * STEP_MS
  // The last-generated version of each resource is the "current" one (validTo = sentinel).
  const lastVersionForResource = Math.floor((COUNT - 1 - resourceIdx) / RESOURCES)
  const isCurrent = version === lastVersionForResource
  const validTo = isCurrent ? END_OF_TIME : validFrom + STEP_MS
  const payloadBytes = 128 + (i % 32) * 64 // 128..2112 bytes, deterministic
  const tenant = `tenant-${i % TENANTS}`
  return { resourceId, type, tenant, version, validFrom, validTo, payloadBytes }
}

mkdirSync(dirname(OUT), { recursive: true })
const lines = new Array(COUNT)
for (let i = 0; i < COUNT; i++) lines[i] = JSON.stringify(row(i))
writeFileSync(OUT, lines.join('\n') + '\n')
console.log(`wrote ${COUNT} rows → ${OUT} (${RESOURCES} resources, ${TYPES.length} types, ${TENANTS} tenants)`)
