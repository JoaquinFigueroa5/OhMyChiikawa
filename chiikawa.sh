#!/usr/bin/env bash
# chiikawa.sh — Linux/macOS launcher for the OhMyChiikawa desktop pet CLI.
# Equivalent to chiikawa.cmd / chiikawa.ps1 on Windows.
set -euo pipefail
exec node "$(dirname "$0")/chiikawa.js" "$@"
