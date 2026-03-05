/**
 * DAG SQL Performance Measurement Client
 *
 * Connects via WebSocket to the DagSqlPerfDO, seeds the tree,
 * then measures each operation individually with per-op timing.
 *
 * Usage:
 *   Terminal 1: npm run dev
 *   Terminal 2: npm test [iterations]
 *
 * The DO clock is frozen during synchronous SQL execution,
 * so all timing is done client-side using performance.now()
 * (sub-millisecond precision). For each measured operation,
 * a noop baseline is interleaved immediately before to produce
 * properly paired differences.
 */

import { performance } from 'node:perf_hooks'
import { WebSocket } from 'ws'

const BASE_URL = process.env.TEST_URL || 'http://localhost:8787'
const WS_URL = BASE_URL.replace('http://', 'ws://').replace('https://', 'wss://')
const ITERATIONS = parseInt(process.argv[2] || process.env.ITERATIONS || '100', 10)
const WARMUP_ITERATIONS = 10

// ─── WebSocket helpers ───────────────────────────────────────────────

let ws
let requestId = 0
const pendingRequests = new Map()

function connect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())

      if (msg.type === 'seeded') {
        const pending = pendingRequests.get('seed')
        if (pending) {
          pending.resolve(msg)
          pendingRequests.delete('seed')
        }
      } else if (msg.type === 'result') {
        const pending = pendingRequests.get(msg.id)
        if (pending) {
          pending.resolve(msg.result)
          pendingRequests.delete(msg.id)
        }
      } else if (msg.type === 'error') {
        // Reject all pending requests on error
        for (const [key, pending] of pendingRequests) {
          pending.reject(new Error(msg.error))
        }
        pendingRequests.clear()
      }
    })
  })
}

function seed() {
  return new Promise((resolve, reject) => {
    pendingRequests.set('seed', { resolve, reject })
    ws.send(JSON.stringify({ action: 'seed' }))
  })
}

function runOp(op, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId
    pendingRequests.set(id, { resolve, reject })
    ws.send(JSON.stringify({ action: 'run', op, params, id }))
  })
}

// ─── Timing ──────────────────────────────────────────────────────────

/**
 * Time a single operation. Returns elapsed ms (sub-ms precision).
 */
async function timeOp(op, params) {
  const start = performance.now()
  await runOp(op, params)
  return performance.now() - start
}

/**
 * Run an operation N times and collect per-op timings.
 */
async function measureOp(op, params, iterations) {
  const timings = []
  for (let i = 0; i < iterations; i++) {
    timings.push(await timeOp(op, params))
  }
  return timings
}

/**
 * Measure an operation with interleaved noop baseline for proper pairing.
 *
 * Each iteration: measure noop, then measure the operation.
 * Adjusted = max(0, raw - paired_noop) for each pair.
 * This is statistically sound because each noop captures the WS latency
 * at the same moment as its paired operation.
 */
async function measureOpWithBaseline(op, params, iterations) {
  const rawTimings = []
  const baselineTimings = []
  const adjustedTimings = []
  for (let i = 0; i < iterations; i++) {
    const baselineMs = await timeOp('noop', {})
    const rawMs = await timeOp(op, params)
    baselineTimings.push(baselineMs)
    rawTimings.push(rawMs)
    adjustedTimings.push(Math.max(0, rawMs - baselineMs))
  }
  return { rawTimings, baselineTimings, adjustedTimings }
}

// ─── Statistics ──────────────────────────────────────────────────────

function computeStats(timings) {
  const sorted = [...timings].sort((a, b) => a - b)
  const n = sorted.length
  return {
    count: n,
    avg: (sorted.reduce((s, v) => s + v, 0) / n),
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    max: sorted[n - 1],
    min: sorted[0],
  }
}

function fmtMs(v) { return v.toFixed(2).padStart(7) + 'ms' }

function printRow(label, stats) {
  console.log(
    `  ${label.padEnd(42)} | ${String(stats.count).padStart(5)} | `
    + `${fmtMs(stats.avg)} | ${fmtMs(stats.p50)} | ${fmtMs(stats.p95)} | ${fmtMs(stats.max)}`,
  )
}

const HEADER = `  ${'Operation'.padEnd(42)} | ${'Count'.padStart(5)} | `
  + `${'Avg'.padStart(9)} | ${'p50'.padStart(9)} | ${'p95'.padStart(9)} | ${'Max'.padStart(9)}`

const SEPARATOR = '  ' + '-'.repeat(42) + '-|-' + '-'.repeat(5) + '-|-'
  + '-'.repeat(9) + '-|-' + '-'.repeat(9) + '-|-' + '-'.repeat(9) + '-|-' + '-'.repeat(9)

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪 DAG SQL Performance Experiment')
  console.log('==================================\n')
  console.log(`Target:     ${WS_URL}`)
  console.log(`Iterations: ${ITERATIONS} per operation (+ ${WARMUP_ITERATIONS} warmup)`)
  console.log(`Timing:     performance.now() (sub-ms precision)`)
  console.log(`Baseline:   interleaved noop paired with each operation`)
  console.log(`Decision gate: resolvePermission p95 < 5ms (after baseline subtraction)\n`)

  // Connect
  console.log('🔌 Connecting...')
  await connect()

  // Seed
  console.log('🌱 Seeding tree...')
  const seedResult = await seed()
  console.log(`   ✅ ${seedResult.stats.nodeCount} nodes, ${seedResult.stats.edgeCount} edges (${seedResult.stats.dagEdgeCount} DAG diamonds)`)

  // Report FK findings
  const fk = seedResult.foreignKeys
  console.log(`\n🔑 Foreign Key Pragma`)
  console.log(`   Default value:      ${fk.defaultValue === 1 ? 'ON (1)' : fk.defaultValue === 0 ? 'OFF (0)' : `unknown (${fk.defaultValue})`}`)
  console.log(`   Current value:      ${fk.currentValue === 1 ? 'ON (1)' : fk.currentValue === 0 ? 'OFF (0)' : `unknown (${fk.currentValue})`}`)
  console.log(`   Enforcement works:  ${fk.enforcementWorks ? '✅ yes (invalid FK INSERT rejected)' : '❌ no (invalid FK INSERT succeeded)'}`)

  const targets = seedResult.testTargets

  // Define the test operations in order
  const tests = [
    { key: 'noop', label: 'noop (baseline)' },
    { key: 'resolve_direct', label: 'resolvePermission (direct grant)' },
    { key: 'resolve_diamond', label: 'resolvePermission (diamond DAG)' },
    { key: 'resolve_deep_write', label: 'resolvePermission (depth 7→2)' },
    { key: 'resolve_root_admin', label: 'resolvePermission (depth 7→root)' },
    { key: 'resolve_no_access', label: 'resolvePermission (no access)' },
    { key: 'ancestors_mid', label: 'findAncestors (depth 4)' },
    { key: 'ancestors_deep', label: 'findAncestors (depth 7)' },
    { key: 'descendants_mid', label: 'findDescendants (depth 2 subtree)' },
    { key: 'descendants_root', label: 'findDescendants (root, all)' },
    { key: 'cycle_safe', label: 'detectCycle (safe edge)' },
    { key: 'cycle_would_cycle', label: 'detectCycle (would create cycle)' },
  ].filter(t => targets[t.key]) // skip if target wasn't generated (e.g., diamond needs enough nodes)

  // Warmup — run each operation a few times to prime SQLite cache
  console.log('\n🔥 Warmup...')
  for (const test of tests) {
    const t = targets[test.key]
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      await runOp(t.op, t.params)
    }
  }

  // ─── Measure ─────────────────────────────────────────────────────

  console.log('\n📊 Measuring...\n')
  const results = new Map()

  // Noop: measure raw only (no baseline to subtract from itself)
  {
    const t = targets['noop']
    process.stdout.write(`  ⏱️  noop (baseline)...`)
    const rawTimings = await measureOp('noop', {}, ITERATIONS)
    const rawStats = computeStats(rawTimings)
    results.set('noop', { key: 'noop', label: 'noop (baseline)', rawStats, adjustedStats: null, note: t.note })
    process.stdout.write(` avg ${rawStats.avg.toFixed(2)}ms\n`)
  }

  // All other operations: interleaved noop baseline for paired subtraction
  for (const test of tests) {
    if (test.key === 'noop') continue
    const t = targets[test.key]
    process.stdout.write(`  ⏱️  ${test.label}...`)
    const { rawTimings, adjustedTimings } = await measureOpWithBaseline(t.op, t.params, ITERATIONS)
    const rawStats = computeStats(rawTimings)
    const adjustedStats = computeStats(adjustedTimings)
    results.set(test.key, { ...test, rawStats, adjustedStats, note: t.note })
    process.stdout.write(` raw avg ${rawStats.avg.toFixed(2)}ms, adjusted avg ${adjustedStats.avg.toFixed(2)}ms\n`)
  }

  // ─── Results ─────────────────────────────────────────────────────

  console.log('\n\n📈 RAW RESULTS (includes WebSocket round-trip overhead)')
  console.log('=======================================================\n')
  console.log(HEADER)
  console.log(SEPARATOR)
  for (const test of tests) {
    const { rawStats } = results.get(test.key)
    printRow(test.label, rawStats)
  }

  // Paired baseline-adjusted results
  console.log('\n\n📈 PAIRED BASELINE-ADJUSTED (each op paired with immediately preceding noop)')
  console.log('=============================================================================\n')
  console.log(HEADER)
  console.log(SEPARATOR)
  for (const test of tests) {
    if (test.key === 'noop') continue
    const { adjustedStats } = results.get(test.key)
    printRow(test.label, adjustedStats)
  }

  // ─── Decision Gate ───────────────────────────────────────────────

  // Gather worst-case adjusted p95 across all resolvePermission variants
  const resolveKeys = tests
    .filter(t => t.key.startsWith('resolve_'))
    .map(t => t.key)

  const worstP95 = Math.max(
    ...resolveKeys.map(key => results.get(key).adjustedStats.p95),
  )
  const worstKey = resolveKeys.reduce((worst, key) =>
    results.get(key).adjustedStats.p95 > results.get(worst).adjustedStats.p95 ? key : worst,
  )

  console.log('\n\n🎯 DECISION GATE')
  console.log('=================\n')
  console.log(`  Worst-case resolvePermission p95 (adjusted): ${worstP95.toFixed(2)}ms`)
  console.log(`  Worst-case scenario: ${results.get(worstKey).label}`)
  console.log(`  Threshold: 5ms`)
  if (worstP95 < 5) {
    console.log(`  ✅ PASS — Ship with N+1 SQL approach`)
  } else {
    console.log(`  ❌ FAIL — Consider CTE or in-memory alternatives`)
  }

  // ─── Memory measurement ───────────────────────────────────────────

  console.log('\n\n💾 CACHE MEMORY MEASUREMENT')
  console.log('============================\n')

  // Ask the DO to build the full cache (tree + permissions) and return it
  const cacheData = await runOp('buildCache', {})
  const jsonStr = JSON.stringify(cacheData)
  const jsonBytes = Buffer.byteLength(jsonStr, 'utf8')

  console.log(`  Tree nodes:        ${cacheData.nodeCount}`)
  console.log(`  Permission grants: ${cacheData.permissionCount}`)
  console.log(`  JSON wire size:    ${(jsonBytes / 1024).toFixed(1)} KB`)

  // Measure V8 heap cost of the deserialized structure.
  // Force GC if available (run with --expose-gc), otherwise best-effort.
  if (global.gc) global.gc()
  const heapBefore = process.memoryUsage().heapUsed

  // Deserialize and hold a reference to prevent GC
  const cache = JSON.parse(jsonStr)

  if (global.gc) global.gc()
  const heapAfter = process.memoryUsage().heapUsed
  const heapDelta = heapAfter - heapBefore

  // Keep reference alive past the measurement
  if (!cache) throw new Error('unreachable')

  console.log(`  V8 heap delta:     ${(heapDelta / 1024).toFixed(1)} KB`)
  console.log(`  128 MB budget:     ${(heapDelta / (128 * 1024 * 1024) * 100).toFixed(3)}%`)

  if (!global.gc) {
    console.log(`\n  ⚠️  For accurate heap measurement, run with: node --expose-gc test/measure.mjs`)
  }

  // Notes
  console.log('\n\n📝 TEST TARGET DETAILS')
  console.log('======================\n')
  for (const test of tests) {
    const { note } = results.get(test.key)
    console.log(`  ${test.label}: ${note}`)
  }

  console.log('')
  ws.close()
  process.exit(0)
}

main().catch((err) => {
  console.error('\n❌ Experiment failed:', err.message)
  console.error(err)
  process.exit(1)
})
