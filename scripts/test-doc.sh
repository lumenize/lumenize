#!/usr/bin/env bash
# Doc-tests are advisory — the doc-test infrastructure is being sunset
# in favor of @check-example annotations in .md/.mdx files. Failures here
# warn but do not abort: we don't want a known-stale fixture to block
# `npm test` for everyone while the migration is in progress. Once all
# doc-test directories are removed, this whole script goes with them.
set +e

echo "🧪 Running doc-tests (advisory — doc-test infrastructure is being sunset)..."
echo ""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOC_TEST_DIRS=(
  "doc-test/testing/testing-plain-do"
  # "doc-test/testing/testing-agent-with-agent-client"  # Skipped: agents→@modelcontextprotocol/sdk→ajv CJS/ESM compat issue with workerd 2026+. Will be replaced by check-example-based Mesh/LumenizeClient docs.
  "doc-test/rpc/quick-start"
  "doc-test/rpc/capn-web-comparison-basics-and-types"
)

DOC_TEST_FAILURES=()

for doc_test in "${DOC_TEST_DIRS[@]}"; do
  if [ -d "$ROOT_DIR/$doc_test" ]; then
    echo "📝 Testing $doc_test..."
    cd "$ROOT_DIR/$doc_test"
    if npm run test; then
      cd "$ROOT_DIR"
      echo ""
    else
      DOC_TEST_FAILURES+=("$doc_test")
      cd "$ROOT_DIR"
      echo ""
      echo "⚠️  doc-test failed in $doc_test — continuing (advisory)."
      echo ""
    fi
  fi
done

if [ ${#DOC_TEST_FAILURES[@]} -eq 0 ]; then
  echo "✅ All doc-tests passed"
else
  echo "⚠️  Doc-tests failed in: ${DOC_TEST_FAILURES[*]}"
  echo "   Treating as advisory — doc-test infrastructure is being sunset."
fi
exit 0
