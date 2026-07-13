# ADR-011: Timestamps Are ISO 8601 UTC Strings

**Date**: 2026-07-11
**Status**: Accepted
**Deciders**: Larry
**Evidence**: `apps/nebula/src/resources.ts` (Snapshots: `validFrom`/`validTo TEXT`, `END_OF_TIME = '9999-01-01T00:00:00.000Z'`, string-compared); the `nebula-auth` schema's epoch-`number` timestamps vs Snapshots' ISO strings (surfaced reviewing `tasks/archive/nebula-auth-surrogate-sub.md`); ADR-004 (the `END_OF_TIME` sentinel).

## Context

Persisted timestamps were split: the Resources/Snapshots history substrate stores ISO 8601 UTC strings as SQLite `TEXT` (`validFrom`/`validTo`, sentinel `9999-01-01T00:00:00.000Z`, compared as strings for range / "current" queries), while `nebula-auth` stored epoch-millis `number`s. SQLite has **no native date/time type** — only column affinity plus `date()`/`strftime()` functions — so a stored timestamp is always *some* encoding you pick.

ISO 8601 Zulu strings win on the axes that matter:
- **Debuggable** — you read `2026-07-11T00:00:00.000Z` in a row or log, not `1752192000000`.
- **Lexical sort = chronological** (fixed-width UTC), so string comparison does range/ordering/"current" queries — which is exactly why the `END_OF_TIME` sentinel works as a plain string that sorts after every real date.
- **Timezone-unambiguous** (`Z`).

Epoch `number`'s only edges — 8 bytes vs ~24, trivial arithmetic — are negligible at these scales, and it's opaque + inconsistent with Snapshots. The reflex (`Date.now()` → `number`) is what a fresh contributor reaches for in week one.

## Decision

**Every persisted or wire timestamp is an ISO 8601 UTC ("Zulu") string** — `YYYY-MM-DDTHH:mm:ss.sssZ`, millisecond precision, always `Z`, fixed width. Stored as SQLite `TEXT`; compared as strings (lexical = chronological). Mint with `new Date().toISOString()`. The end-of-time sentinel is `9999-01-01T00:00:00.000Z` (ADR-004).

**Carve-out — protocol-mandated formats keep their spec:** JWT `exp`/`iat` are NumericDate (epoch *seconds*) by RFC 7519; HTTP `Date`/`Expires` are RFC 1123. The commitment governs *our* schema/wire timestamps, not fields whose format a standard already fixes.

In-memory arithmetic may use `Date`/number freely — the commitment is the **persisted/wire representation**. The clock caveat is unchanged: `Date.now()`/`new Date()` are pinned within an invocation (`coding-style.md` § IDs; the `cf-clock-traps` memory) — that's about *when* you read the clock, orthogonal to how you *encode* it.

## Alternatives considered

| Approach | Why rejected |
|---|---|
| **Epoch `number` (millis)** | Opaque in DB/logs; no lexical sentinel; the split we're closing (Snapshots already uses ISO). Compactness/arithmetic edge is negligible here. |
| **Mixed per-package** (status quo) | The reviewer-confusion + bug surface of two conventions — a comparison that silently mixes a `number` and a string sorts wrong. One representation, everywhere. |
| **SQLite `REAL` Julian day** | Native to SQLite's date funcs but unreadable and floating-point-imprecise — worse than TEXT on every axis we care about. |

## Consequences

### Positive
- One representation across auth, Resources, and wire — debuggable, and string range-queries + the `END_OF_TIME` sentinel work uniformly (ADR-004 generalized).
- Comparisons (`expiresAt < now`) stay correct as lexical string compares (fixed-width Zulu).

### Negative / mitigations
- **Fixed-width discipline** — always `.sssZ`, always `Z`; a stray unpadded or offset string breaks lexical ordering. *Mitigation:* mint only via `new Date().toISOString()` (never hand-format).
- **~24 bytes vs 8, string compare marginally slower** — negligible at auth/Resource scale. If a high-frequency time-series ever needs epoch ints, that's a documented local exception, not the default.
