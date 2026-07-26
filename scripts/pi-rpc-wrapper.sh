#!/usr/bin/env bash
#
# Wrapper to keep pi --mode rpc alive with an open stdin.
# Used by systemd services thetis-gateway-discord and thetis-gateway-whatsapp.
#
# Usage: pi-rpc-wrapper.sh [discord|whatsapp]
#

set -euo pipefail

PLATFORM="${1:-}"

# Ensure pi is in PATH
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"

# Source any local env overrides
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && source "$SCRIPT_DIR/../.env"

# Set GATEWAY_PLATFORM if provided (used by the extension to start only one gateway)
if [ -n "$PLATFORM" ]; then
  export GATEWAY_PLATFORM="$PLATFORM"
fi

# Determine session name based on platform
SESSION_NAME="gateway"
if [ -n "$PLATFORM" ]; then
  SESSION_NAME="gateway-$PLATFORM"
fi

# Run pi in RPC mode with an open stdin so it doesn't exit.
# 'tail -f /dev/null' provides an open pipe that never produces data.
exec tail -f /dev/null | pi --mode rpc --name "$SESSION_NAME"
