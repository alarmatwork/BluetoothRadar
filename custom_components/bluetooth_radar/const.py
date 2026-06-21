"""Constants for the Bluetooth Radar integration."""

from __future__ import annotations

DOMAIN = "bluetooth_radar"

# How often (seconds) a snapshot is pushed to subscribed radar cards.
PUSH_INTERVAL = 1.0

# --- Configurable options (set via the integration's options flow) ---

# RSSI (dBm) measured at 1 metre from a reference device. Used as the
# anchor for the log-distance path-loss model. Typical value ~ -59 dBm.
CONF_MEASURED_POWER = "measured_power"
DEFAULT_MEASURED_POWER = -59

# Path-loss exponent (environment factor). 2.0 = free space,
# 2.5-4.0 = typical indoor environments with walls/furniture.
CONF_PATH_LOSS = "path_loss_exponent"
DEFAULT_PATH_LOSS = 2.5

# Outer range of the radar in metres. Devices further than this are
# drawn clamped to the edge ring.
CONF_MAX_DISTANCE = "max_distance"
DEFAULT_MAX_DISTANCE = 15.0

# Drop a device from the radar if it has not been heard from in this
# many seconds.
CONF_STALE_SECONDS = "stale_seconds"
DEFAULT_STALE_SECONDS = 60
