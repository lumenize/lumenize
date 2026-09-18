#!/usr/bin/env bash
# Doc checks in two tiers, and only the first can fail the run:
# 1. The @check-example checker (`cd website && npm run check-examples`): every
#    doc code block that names a test or source file must still match it.
# 2. The legacy doc-test suites below, which are advisory — the doc-test
#    infrastructure is being sunset in favor of @check-example annotations in
#    .md/.mdx files. Their failures warn but do not abort: we don't want a
#    known-stale fixture to block `npm test` for everyone while the migration
#    is in progress. Once all doc-test directories are removed, this tier goes
#    with them.
# Local runs only, decided 2026-09-18: CI never deploys the website, so it does
# not run the website's doc check either.
set +e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "🔍 Checking @check-example blocks (a stale block fails this run)..."
(cd "$ROOT_DIR/website" && npm run --silent check-examples)
CHECK_EXAMPLES_STATUS=$?
echo ""

echo "🧪 Running doc-tests (advisory — doc-test infrastructure is being sunset)..."
echo ""

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

if [ "$CHECK_EXAMPLES_STATUS" -ne 0 ]; then
  echo ""
  echo "❌ @check-example blocks failed verification — see the checker output at the top."
  exit 1
fi
exit 0
