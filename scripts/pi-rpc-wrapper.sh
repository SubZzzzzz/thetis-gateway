#!/usr/bin/env bash
#
# Wrapper to keep pi --mode rpc alive with an open stdin.
# Used by systemd service thetis-gateway.
#

set -euo pipefail

# Ensure pi is in PATH
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"

# Source any local env overrides
[ -f "$HOME/.pi/agent/extensions/thetis-gateway/.env" ] && source "$HOME/.pi/agent/extensions/thetis-gateway/.env"

# Run pi in RPC mode with an open stdin so it doesn't exit.
# 'tail -f /dev/null' provides an open pipe that never produces data.
exec tail -f /dev/null | pi --mode rpc --name "gateway"
