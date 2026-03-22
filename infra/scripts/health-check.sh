#!/usr/bin/env bash
# ──────────────────────────────────────────────
# Cortex Hub — Health Check Script
# Checks all backend services and reports status
# ──────────────────────────────────────────────
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_service() {
  local name="$1"
  local url="$2"
  local response

  if response=$(curl -sf --max-time 5 "$url" 2>/dev/null); then
    printf "  ${GREEN}✓${NC} %-20s %s\n" "$name" "healthy"
    return 0
  else
    printf "  ${RED}✗${NC} %-20s %s\n" "$name" "DOWN"
    return 1
  fi
}

echo ""
echo "╭──────────────────────────────────────╮"
echo "│     Cortex Hub — Health Check        │"
echo "╰──────────────────────────────────────╯"
echo ""

FAILURES=0

check_service "Qdrant"        "http://localhost:6333/healthz"    || ((FAILURES++))
check_service "Dashboard API" "http://localhost:4000/health"     || ((FAILURES++))

echo ""
if [ "$FAILURES" -eq 0 ]; then
  printf "${GREEN}All services healthy ✓${NC}\n"
else
  printf "${YELLOW}${FAILURES} service(s) down${NC}\n"
fi
echo ""
