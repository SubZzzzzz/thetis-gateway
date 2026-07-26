#!/usr/bin/env bash
#
# Install or remove the systemd user services for thetis-gateway boot.
# Installs two separate services: thetis-gateway-discord and thetis-gateway-whatsapp
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"

SERVICE_NAMES=("thetis-gateway-discord" "thetis-gateway-whatsapp")
SERVICE_SOURCES=("pi-gateway-discord.service" "pi-gateway-whatsapp.service")

usage() {
  echo "Usage: $0 {install|remove|status}"
  exit 1
}

install_service() {
  echo "Installing gateway user services..."

  mkdir -p "$SERVICE_DIR"
  
  for i in "${!SERVICE_NAMES[@]}"; do
    local name="${SERVICE_NAMES[$i]}"
    local src="$EXT_DIR/systemd/${SERVICE_SOURCES[$i]}"
    local dst="$SERVICE_DIR/$name.service"
    
    echo "  Installing $name..."
    sed -e "s|@@EXT_DIR@@|$EXT_DIR|g" "$src" > "$dst"
    systemctl --user daemon-reload
    systemctl --user enable "$name"
    echo "  Enabled $name.service"
  done

  echo ""
  echo "IMPORTANT: For the services to start at BOOT (before first login):"
  echo "  loginctl enable-linger \$USER"
  echo ""
  echo "Start now with:"
  echo "  /gateway-boot start"
  echo ""
  echo "Or manually:"
  echo "  systemctl --user start thetis-gateway-discord"
  echo "  systemctl --user start thetis-gateway-whatsapp"
}

remove_service() {
  echo "Removing gateway user services..."

  for name in "${SERVICE_NAMES[@]}"; do
    echo "  Removing $name..."
    systemctl --user stop "$name" 2>/dev/null || true
    systemctl --user disable "$name" 2>/dev/null || true
    
    local dst="$SERVICE_DIR/$name.service"
    if [ -f "$dst" ]; then
      rm "$dst"
    fi
  done

  systemctl --user daemon-reload
  echo "Removed."
}

show_status() {
  for name in "${SERVICE_NAMES[@]}"; do
    echo "=== $name ==="
    systemctl --user status "$name" --no-pager 2>&1 || true
    echo ""
  done
}

case "${1:-}" in
  install) install_service ;;
  remove)  remove_service ;;
  status)  show_status ;;
  *)       usage ;;
esac
