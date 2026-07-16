#!/usr/bin/env bash
#
# Install or remove the systemd user service for thetis-gateway boot.
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_NAME="thetis-gateway"
SERVICE_SRC="$EXT_DIR/systemd/pi-gateway.service"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DST="$SERVICE_DIR/$SERVICE_NAME.service"

usage() {
  echo "Usage: $0 {install|remove|status}"
  exit 1
}

install_service() {
  echo "Installing $SERVICE_NAME user service..."

  mkdir -p "$SERVICE_DIR"
  sed -e "s|@@EXT_DIR@@|$EXT_DIR|g" "$SERVICE_SRC" > "$SERVICE_DST"

  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE_NAME"

  echo "Enabled $SERVICE_NAME.service"
  echo ""
  echo "IMPORTANT: For the service to start at BOOT (before first login):"
  echo "  loginctl enable-linger \$USER"
  echo ""
  echo "Start now with:"
  echo "  systemctl --user start $SERVICE_NAME"
  echo ""
  echo "Or start via Pi:"
  echo "  /gateway boot start"
}

remove_service() {
  echo "Removing $SERVICE_NAME user service..."

  systemctl --user stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl --user disable "$SERVICE_NAME" 2>/dev/null || true

  if [ -f "$SERVICE_DST" ]; then
    rm "$SERVICE_DST"
  fi

  systemctl --user daemon-reload
  echo "Removed."
}

show_status() {
  systemctl --user status "$SERVICE_NAME" --no-pager || true
}

case "${1:-}" in
  install) install_service ;;
  remove)  remove_service ;;
  status)  show_status ;;
  *)       usage ;;
esac
