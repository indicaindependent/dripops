#!/usr/bin/env bash
# DripOps MCP Server — smoke test
# Sends a few JSON-RPC messages over stdio and checks responses.
# Usage: ./test/smoke-test.sh

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f dist/index.js ]; then
  echo "Building first..."
  npm run build
fi

echo "=== Test 1: tools/list ==="
RESPONSE=$( ( cat << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
) | timeout 5 node dist/index.js 2>/dev/null | tail -1)

if echo "$RESPONSE" | grep -q '"name":"splunk_search"'; then
  echo "✅ tools/list returned splunk_search"
else
  echo "❌ tools/list missing splunk_search"
  echo "Response: $RESPONSE"
  exit 1
fi

if echo "$RESPONSE" | grep -q '"name":"github_open_pr"'; then
  echo "✅ tools/list returned github_open_pr"
else
  echo "❌ tools/list missing github_open_pr"
  exit 1
fi

if echo "$RESPONSE" | grep -q '"name":"telegram_alert"'; then
  echo "✅ tools/list returned telegram_alert"
else
  echo "❌ tools/list missing telegram_alert"
  exit 1
fi

echo ""
echo "=== Test 2: dripops_health (no env — should error cleanly) ==="
RESPONSE=$( ( cat << 'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dripops_health","arguments":{}}}
EOF
) | timeout 5 node dist/index.js 2>/dev/null | tail -1)

# Either succeeds (if HEC_BRIDGE_URL is reachable) or errors gracefully — both are OK
if echo "$RESPONSE" | grep -qE '("ok":true|"isError":true|Error in dripops_health)'; then
  echo "✅ dripops_health handled (success or graceful error)"
else
  echo "❌ dripops_health unexpected response"
  echo "Response: $RESPONSE"
  exit 1
fi

echo ""
echo "🎉 ALL SMOKE TESTS PASS"
