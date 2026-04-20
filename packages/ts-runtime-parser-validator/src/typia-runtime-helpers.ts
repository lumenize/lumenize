/**
 * Inlined typia runtime helpers — the functions typia's emitted validators
 * call at runtime. Copied verbatim from typia@12.0.2 so the generated module
 * can be self-contained (no `typia/lib/internal/*` imports at the facet
 * boundary).
 *
 * Each export is a string of JS source that gets embedded as a local const
 * in the generated module. Phase 5 will expand this set to cover every
 * helper typia can reference (format validators, type guards, TypeGuardError,
 * etc.). Phase 1 spike covers only the two typia reaches for from
 * `createValidate<T>()`:
 *   - `_validateReport` — called per error during validation
 *   - `_createStandardSchema` — wraps the validator with a Standard Schema
 *     v1 adapter
 *
 * Format: each entry wraps the helper's export in an IIFE that returns an
 * object matching typia's `import * as X from "..."` namespace shape.
 *
 * Source: typia@12.0.2 lib/internal/_validateReport.mjs and
 * _createStandardSchema.mjs. Re-check on typia upgrade.
 */

export const INLINED_VALIDATE_REPORT = `const __typia_transform__validateReport = (() => {
  const _validateReport = (array) => {
    const reportable = (path) => {
      if (array.length === 0) return true;
      const last = array[array.length - 1].path;
      return path.length > last.length || last.substring(0, path.length) !== path;
    };
    return (exceptable, error) => {
      if (exceptable && reportable(error.path)) {
        if (error.value === undefined)
          error.description ??= [
            "The value at this path is \`undefined\`.",
            "",
            \`Please fill the \\\`\${error.expected}\\\` typed value next time.\`,
          ].join("\\n");
        array.push(error);
      }
      return false;
    };
  };
  return { _validateReport };
})();`;

/**
 * Inlined from typia@12.0.2 lib/internal/_accessExpressionAsString.mjs.
 * Referenced by typia's emitted validators when walking object keys (e.g.,
 * inside Record<string, T> and index-signature validation).
 */
export const INLINED_ACCESS_EXPRESSION_AS_STRING = `const __typia_transform__accessExpressionAsString = (() => {
  const RESERVED = new Set([
    "break","case","catch","class","const","continue","debugger","default","delete","do",
    "else","enum","export","extends","false","finally","for","function","if","import",
    "in","instanceof","new","null","return","super","switch","this","throw","true","try",
    "typeof","var","void","while","with",
  ]);
  const reserved = (str) => RESERVED.has(str);
  const variable = (str) => reserved(str) === false && /^[a-zA-Z_$][a-zA-Z_$0-9]*$/g.test(str);
  const _accessExpressionAsString = (str) => variable(str) ? \`.\${str}\` : \`[\${JSON.stringify(str)}]\`;
  return { _accessExpressionAsString };
})();`;

export const INLINED_CREATE_STANDARD_SCHEMA = `const __typia_transform__createStandardSchema = (() => {
  var PathParserState;
  (function (PathParserState) {
    PathParserState[PathParserState["Start"] = 0] = "Start";
    PathParserState[PathParserState["Property"] = 1] = "Property";
    PathParserState[PathParserState["StringKey"] = 2] = "StringKey";
    PathParserState[PathParserState["NumberKey"] = 3] = "NumberKey";
  })(PathParserState || (PathParserState = {}));

  const typiaPathToStandardSchemaPath = (path) => {
    if (!path.startsWith("$input")) {
      throw new Error(\`Invalid path: \${JSON.stringify(path)}\`);
    }
    const segments = [];
    let currentSegment = "";
    let state = PathParserState.Start;
    let index = "$input".length - 1;
    while (index < path.length - 1) {
      index++;
      const char = path[index];
      if (state === PathParserState.Property) {
        if (char === "." || char === "[") {
          segments.push({ key: currentSegment });
          state = PathParserState.Start;
        } else if (index === path.length - 1) {
          currentSegment += char;
          segments.push({ key: currentSegment });
          index++;
          state = PathParserState.Start;
        } else {
          currentSegment += char;
        }
      } else if (state === PathParserState.StringKey) {
        if (char === '"') {
          segments.push({ key: JSON.parse(currentSegment + char) });
          index += 2;
          state = PathParserState.Start;
        } else if (char === "\\\\") {
          currentSegment += path[index];
          index++;
          currentSegment += path[index];
        } else {
          currentSegment += char;
        }
      } else if (state === PathParserState.NumberKey) {
        if (char === "]") {
          segments.push({ key: Number.parseInt(currentSegment) });
          index++;
          state = PathParserState.Start;
        } else {
          currentSegment += char;
        }
      }
      if (state === PathParserState.Start && index < path.length - 1) {
        const newChar = path[index];
        currentSegment = "";
        if (newChar === "[") {
          if (path[index + 1] === '"') {
            state = PathParserState.StringKey;
            index++;
            currentSegment = '"';
          } else {
            state = PathParserState.NumberKey;
          }
        } else if (newChar === ".") {
          state = PathParserState.Property;
        } else {
          throw new Error("Unreachable: pointer points invalid character");
        }
      }
    }
    if (state !== PathParserState.Start) {
      throw new Error(\`Failed to parse path: \${JSON.stringify(path)}\`);
    }
    return segments;
  };

  const _createStandardSchema = (fn) => Object.assign(fn, {
    "~standard": {
      version: 1,
      vendor: "typia",
      validate: (input) => {
        const result = fn(input);
        if (result.success) {
          return { value: result.data };
        } else {
          return {
            issues: result.errors.map((error) => ({
              message: \`expected \${error.expected}, got \${error.value}\`,
              path: typiaPathToStandardSchemaPath(error.path),
            })),
          };
        }
      },
    },
  });

  return { _createStandardSchema };
})();`;
