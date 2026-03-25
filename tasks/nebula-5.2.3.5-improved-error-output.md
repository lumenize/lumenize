# Phase 5.2.3.5: Improved Error Context in `validate()` Output

**Status**: Complete
**Package**: `packages/ts-runtime-validator/`
**Depends on**: Phase 5.2.2 (validate is implemented and tested)
**Parent**: `tasks/nebula-5.2-tsc-validation.md`

## Problem

When `validate()` returns errors, the `line` field is meaningless — it refers to a line in the generated TypeScript program that the caller never sees. And for type-mismatch errors (code 2322), the `message` from tsc is context-free:

```
Type 'number' is not assignable to type 'string'.
```

The caller has no idea which property caused this. The `property` field only populates for error patterns that name the property in the message text (missing properties, excess properties), not for type mismatches.

## Solution

Enrich the `message` field with a trimmed snippet from the generated program, so the caller gets:

```
Type 'number' is not assignable to type 'string'. → title: 42,
```

### Implementation Steps

### 1. Make `toTypeScript()` emit one property per line

Currently objects emit on one line: `{title: "foo", done: true}`. Change to multi-line:

```typescript
{
  title: "foo",
  done: true,
}
```

**File**: `src/to-typescript.ts`, the `tag === 'object'` branch (~line 241-252).

Change from:
```typescript
return `{${props.join(', ')}}`;
```

To multi-line with 2-space indent (relative to current depth). This makes the `line` field from tsc diagnostics point to the exact property that caused the error.

Also consider: arrays, Maps, Sets — should these also go multi-line? Probably yes for arrays of objects, but simple arrays like `[1, 2, 3]` can stay inline. Start with objects only and extend if needed.

### 2. Pass the generated program text into `toValidationError()`

**File**: `src/validate.ts`

Currently `validate()` calls `toTypeScript()` and `checkFiles()` independently, then maps diagnostics through `toValidationError()` which only sees `DiagnosticInfo`. The generated program text needs to flow through so we can extract the relevant line.

```typescript
// Current
errors: diagnostics.map(toValidationError),

// New — pass generatedProgram so we can extract context
const programLines = generatedProgram.split('\n');
errors: diagnostics.map(d => toValidationError(d, programLines)),
```

### 3. Enrich `message` with line context

In `toValidationError()`, when the diagnostic has a `line` and that line exists in the generated program, append the trimmed snippet:

```typescript
function toValidationError(d: DiagnosticInfo, programLines?: string[]): ValidationError {
  let message = d.message;

  // Enrich with generated-program context when available
  if (d.line !== undefined && d.source === 'value' && programLines) {
    const lineText = programLines[d.line - 1]; // 1-based → 0-based
    if (lineText) {
      const trimmed = lineText.trim();
      // Remove trailing comma if present
      const snippet = trimmed.replace(/,\s*$/, '');
      // Cap total message at ~120 chars
      const candidate = `${d.message} → ${snippet}`;
      message = candidate.length <= 120 ? candidate : `${d.message} → ${snippet.slice(0, 120 - d.message.length - 4)}...`;
    }
  }

  const error: ValidationError = { message, code: d.code, source: mapSource(d.fileName) };
  // ...rest unchanged
}
```

### 4. Also extract `property` from the line context

When tsc doesn't include the property name in the message (type mismatches), we can now extract it from the generated program line. A line like `  title: 42,` clearly starts with the property name:

```typescript
// After enriching message, also try to extract property from line context
if (prop === undefined && lineText) {
  const keyMatch = lineText.trim().match(/^(?:"([^"]+)"|(\w+))\s*:/);
  if (keyMatch) prop = keyMatch[1] ?? keyMatch[2];
}
```

This means `property` will be populated for virtually all object-property errors, not just the subset where tsc includes it in the message text.

## Testing

- Update existing tests to expect enriched messages
- Add test: flat object type mismatch → message includes ` → title: 42`
- Add test: nested object → message includes the inner property line
- Add test: array element type mismatch → verify context is useful
- Add test: `source: 'type-definitions'` errors are NOT enriched (no generated program context)
- Add test: message truncation at ~120 chars for long lines
- Add test: `property` is now populated for type-mismatch errors

## Non-Goals

- Reconstructing full property paths for nested errors (e.g., `a.b.c`) — that's a separate, harder problem
- Changing the `line` field semantics — it stays as-is (now meaningful with multi-line output)
- Pretty-printing the entire generated program — just enough structure for per-property lines
