#!/usr/bin/env bash
set -e

# Run all doc-tests
echo "🧪 Running doc-tests..."
echo ""

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOC_TEST_DIRS=(
  "doc-test/testing/testing-plain-do"
  "doc-test/testing/testing-agent-with-agent-client"
  "doc-test/rpc/quick-start"
)

for doc_test in "${DOC_TEST_DIRS[@]}"; do
  if [ -d "$doc_test" ]; then
    echo "📝 Testing $doc_test..."
    cd "$ROOT_DIR/$doc_test"
    npm run test
    echo ""
  fi
done

cd "$ROOT_DIR"
echo "✅ All doc-tests passed"
