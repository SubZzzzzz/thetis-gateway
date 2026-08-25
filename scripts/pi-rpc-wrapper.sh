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

# Named pipe for IPC (extension writes commands, wrapper sends them to Pi)
PIPE_FILE="/tmp/thetis-gateway-pipe-${PLATFORM:-default}"
CMD_FILE="/tmp/thetis-gateway-cmd-${PLATFORM:-default}"

# Clean up old files
rm -f "$PIPE_FILE" "$CMD_FILE"
touch "$CMD_FILE"

# Create named pipe
mkfifo "$PIPE_FILE"

# Keep the pipe open (fd 3)
exec 3<>"$PIPE_FILE"

# Process that reads command file and writes to pipe
(
  while true; do
    if [ -s "$CMD_FILE" ]; then
      cat "$CMD_FILE" >&3
      > "$CMD_FILE"
    fi
    sleep 0.1
  done
) &

# Run pi in RPC mode reading from the pipe
exec pi --mode rpc --name "$SESSION_NAME" <&3
