"""Constants for the Flight Radar integration."""

from __future__ import annotations

DOMAIN = "flight_radar"

# Where to set the radar centre and how far it reaches.
# NB: the keys are deliberately NOT "latitude"/"longitude" — HA's frontend
# special-cases those exact names into a combined map widget that fails to save
# a manually-typed longitude. Custom names render as plain number fields.
CONF_LATITUDE = "center_latitude"
CONF_LONGITUDE = "center_longitude"
CONF_RADIUS = "radius"  # km
DEFAULT_RADIUS = 100.0

# Poll cadence (seconds). OpenSky throttles aggressively, so keep this
# reasonably high unless you use a local receiver.
CONF_UPDATE_INTERVAL = "update_interval"
DEFAULT_UPDATE_INTERVAL = 15

# Data source selection.
CONF_SOURCE = "source"
SOURCE_OPENSKY = "opensky"
SOURCE_LOCAL = "local"
DEFAULT_SOURCE = SOURCE_OPENSKY

# OpenSky OAuth2 client credentials (optional; without them anonymous
# access is used, which is heavily rate-limited).
CONF_OPENSKY_CLIENT_ID = "opensky_client_id"
CONF_OPENSKY_CLIENT_SECRET = "opensky_client_secret"

# Local ADS-B receiver aircraft.json URL (dump1090 / tar1090 / readsb).
CONF_LOCAL_URL = "local_url"

# Conversions for display.
M_TO_FT = 3.28084
MPS_TO_KT = 1.943844
MPS_TO_FTMIN = 196.850394

# Route (departure/arrival) lookups are cached this long (seconds); routes for
# a callsign rarely change within a flight.
ROUTE_CACHE_TTL = 3600

# Max NEW route lookups per poll cycle, so labels fill in gradually (nearest
# aircraft first) instead of hammering adsbdb on the first poll.
MAX_ROUTE_LOOKUPS_PER_CYCLE = 8
