#!/usr/bin/env bash
set -e

# Run all doc-tests
echo "🧪 Running doc-tests..."
echo ""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOC_TEST_DIRS=(
  "doc-test/testing/testing-plain-do"
  # "doc-test/testing/testing-agent-with-agent-client"  # Skipped: agents→@modelcontextprotocol/sdk→ajv CJS/ESM compat issue with workerd 2026+. Will be replaced by check-example-based Mesh/LumenizeClient docs.
  "doc-test/rpc/quick-start"
  "doc-test/rpc/capn-web-comparison-basics-and-types"
)

for doc_test in "${DOC_TEST_DIRS[@]}"; do
  if [ -d "$ROOT_DIR/$doc_test" ]; then
    echo "📝 Testing $doc_test..."
    cd "$ROOT_DIR/$doc_test"
    npm run test
    cd "$ROOT_DIR"
    echo ""
  fi
done

echo "✅ All doc-tests passed"
