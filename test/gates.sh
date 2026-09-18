#!/usr/bin/env bash
# Mechanical gate for kimi-webbridge-mcp.
#
#   bash test/gates.sh                 # browser-free gates (CI-safe)
#   bash test/gates.sh --live          # also run the real-browser E2E
#   bash test/gates.sh --live --keep   # ... and leave the test tab open
#
# Exit codes: 0 all executed gates passed · 1 a gate failed · 3 the live E2E could
# not run (no daemon / no extension connected). A skipped gate is always printed —
# it is never silently counted as a pass.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

LIVE=0
KEEP=""
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --keep) KEEP="--keep" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

pass=0
fail=0
skipped=()
declare -a ROWS

record() { # name status detail
  ROWS+=("$(printf '%-42s %-6s %s' "$1" "$2" "$3")")
  case "$2" in
    PASS) pass=$((pass + 1)) ;;
    FAIL) fail=$((fail + 1)) ;;
    SKIP) skipped+=("$1") ;;
  esac
  printf '%s %s — %s\n' "$2" "$1" "$3"
}

run() { # name command...
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    record "$name" PASS "$(printf '%s' "$out" | tail -n 1 | cut -c1-100)"
  else
    record "$name" FAIL "exit $? — $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ' | cut -c1-160)"
  fi
}

# ── 1. syntax of every shipped source ────────────────────────────────────────
syntax_ok=1
for f in server.mjs lib/*.mjs lib/*.page.js test/*.mjs; do
  node --check "$f" >/dev/null 2>&1 || { echo "syntax error: $f" >&2; syntax_ok=0; }
done
if [ "$syntax_ok" = 1 ]; then record "node --check (all sources)" PASS "$(ls lib/*.mjs lib/*.page.js server.mjs test/*.mjs | wc -l | tr -d ' ') files"; else record "node --check (all sources)" FAIL "see above"; fi

# ── 2. the fixture's inline script must parse too ────────────────────────────
fixture_js="$(node -e '
const fs=require("fs");
const html=fs.readFileSync("test/fixture.html","utf8");
const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
process.stdout.write(m.map(x=>x[1]).join("\n;\n"));
')"
if printf '%s' "$fixture_js" | node --check /dev/stdin >/dev/null 2>&1; then
  record "fixture inline script parses" PASS "test/fixture.html"
else
  record "fixture inline script parses" FAIL "test/fixture.html"
fi

# ── 3. unit tests (no browser, no daemon) ───────────────────────────────────
unit_out="$(node --test test/unit.test.mjs 2>&1)"
if printf '%s' "$unit_out" | grep -qE '^# fail 0|^ℹ fail 0'; then
  record "unit tests (node --test test/unit.test.mjs)" PASS "$(printf '%s' "$unit_out" | grep -E '^# (tests|pass)|^ℹ (tests|pass)' | tr '\n' ' ')"
else
  record "unit tests (node --test test/unit.test.mjs)" FAIL "$(printf '%s' "$unit_out" | grep -E '^# fail|^ℹ fail|not ok' | head -3 | tr '\n' ' ')"
fi

# ── 4. MCP stdio smoke test against the fake daemon ─────────────────────────
run "mock MCP smoke (fake daemon)" node test/mcp-smoke.mjs --mock

# ── 5. live end-to-end (real browser) — opt-in only ─────────────────────────
if [ "$LIVE" = 1 ]; then
  node test/e2e-live.mjs $KEEP
  case $? in
    0) record "live E2E (real browser)" PASS "all checks passed" ;;
    3) record "live E2E (real browser)" SKIP "no WebBridge daemon / extension connected" ;;
    *) record "live E2E (real browser)" FAIL "see output above" ;;
  esac
else
  record "live E2E (real browser)" SKIP "not requested — run: bash test/gates.sh --live"
fi

echo
echo "──────── gate summary ────────"
printf '%s\n' "${ROWS[@]}"
echo "passed=$pass failed=$fail skipped=${#skipped[@]}${skipped[0]:+ (${skipped[*]})}"

if [ "$fail" -gt 0 ]; then exit 1; fi
if [ "$LIVE" = 1 ] && [ "${#skipped[@]}" -gt 0 ]; then exit 3; fi
exit 0
