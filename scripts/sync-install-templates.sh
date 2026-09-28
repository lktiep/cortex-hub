#!/bin/bash
# Thin wrapper around sync_install_templates.py — see that file for what this keeps in step.
#
#   sync-install-templates.sh            write the canonical files into both installers
#   sync-install-templates.sh --check    report drift and exit 1 (for CI)
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/sync_install_templates.py "$@"
