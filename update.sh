#!/usr/bin/env bash
#
# update.sh — pull the latest Radar code and deploy it into Home Assistant.
#
# Deployment model (see README → Installation):
#   * everything is COPIED out of the clone into HA's config. Symlinks are
#     unreliable here (HA's web server won't serve www symlinks, and the
#     integration symlinks proved flaky), so we copy real files every run.
#
# Usage:
#   ./update.sh             pull + deploy (then restart HA yourself)
#   ./update.sh --restart   pull + deploy + restart Home Assistant Core
#
# Override paths via env if your layout differs, e.g.:
#   SRC=/config/bluetooth-radar-src CFG=/config ./update.sh

set -euo pipefail

# --- paths (edit these if your install differs) ---
SRC="${SRC:-/homeassistant/bluetooth-radar-src}"   # the git clone
CFG="${CFG:-/homeassistant}"                        # HA config dir (has configuration.yaml)

CC="$CFG/custom_components"
WWW="$CFG/www"

echo "==> Source clone : $SRC"
echo "==> HA config    : $CFG"

# --- sanity checks ---
if [ ! -d "$SRC/.git" ]; then
  echo "ERROR: $SRC is not a git clone. Clone it first:"
  echo "  git clone https://github.com/alarmatwork/BluetoothRadar.git $SRC"
  exit 1
fi
if [ ! -f "$CFG/configuration.yaml" ]; then
  echo "WARNING: $CFG/configuration.yaml not found — is CFG correct?"
fi

# --- pull latest ---
echo "==> git pull"
git -C "$SRC" pull --ff-only

# the pull must have produced real files (guards against a broken checkout)
if [ ! -f "$SRC/custom_components/flight_radar/manifest.json" ]; then
  echo "ERROR: $SRC working tree looks broken (flight_radar missing on disk)."
  echo "Re-clone:  rm -rf $SRC && git clone https://github.com/alarmatwork/BluetoothRadar.git $SRC"
  exit 1
fi

mkdir -p "$CC" "$WWW"

# --- copy the integrations ---
# rm -rf first removes any previous copy *or* stale symlink so we never nest
# (rm -rf on a symlink removes only the link, not its target).
echo "==> copying integrations"
rm -rf "$CC/bluetooth_radar" "$CC/flight_radar"
cp -r "$SRC/custom_components/bluetooth_radar" "$CC/bluetooth_radar"
cp -r "$SRC/custom_components/flight_radar"    "$CC/flight_radar"

# --- copy the card (symlinks aren't served from www) ---
# Remove the destination first: if it's an old symlink, plain cp would error
# ("are the same file") or follow it; rm guarantees we write a real file.
echo "==> copying card"
rm -f "$WWW/bluetooth-radar-card.js"
cp "$SRC/www/bluetooth-radar-card.js" "$WWW/bluetooth-radar-card.js"

# --- verify ---
echo "==> deployed:"
ls -ldL "$CC/bluetooth_radar" "$CC/flight_radar" "$WWW/bluetooth-radar-card.js"

# --- restart (optional) ---
if [ "${1:-}" = "--restart" ]; then
  if command -v ha >/dev/null 2>&1; then
    echo "==> restarting Home Assistant Core"
    ha core restart
  else
    echo "NOTE: 'ha' CLI not available here — restart HA from the UI."
  fi
else
  echo
  echo "Done. Now:"
  echo "  - restart Home Assistant (integrations changed), and"
  echo "  - hard-refresh the dashboard (Ctrl/Cmd-Shift-R) for the card."
  echo "Tip: re-run with --restart to restart HA automatically."
fi
