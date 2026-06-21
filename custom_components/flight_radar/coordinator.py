"""Polling coordinator that turns flight data into radar snapshots."""

from __future__ import annotations

import logging
import math
import time
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    CONF_LATITUDE,
    CONF_LOCAL_URL,
    CONF_LONGITUDE,
    CONF_OPENSKY_CLIENT_ID,
    CONF_OPENSKY_CLIENT_SECRET,
    CONF_RADIUS,
    CONF_SOURCE,
    CONF_UPDATE_INTERVAL,
    DEFAULT_RADIUS,
    DEFAULT_UPDATE_INTERVAL,
    DEFAULT_SOURCE,
    DOMAIN,
    M_TO_FT,
    MPS_TO_FTMIN,
    MPS_TO_KT,
    ROUTE_CACHE_TTL,
    SOURCE_LOCAL,
)
from .sources import BBox, LocalAdsbSource, OpenSkySource

_LOGGER = logging.getLogger(__name__)

_EARTH_RADIUS_KM = 6371.0


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2 (0 = north, clockwise)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    y = math.sin(dlambda) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(
        dlambda
    )
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


class FlightRadarCoordinator(DataUpdateCoordinator[list[dict[str, Any]]]):
    """Fetches aircraft and reduces them to radar blips around a centre."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        opts = entry.options
        self.latitude = opts.get(CONF_LATITUDE, hass.config.latitude)
        self.longitude = opts.get(CONF_LONGITUDE, hass.config.longitude)
        self.radius = opts.get(CONF_RADIUS, DEFAULT_RADIUS)
        interval = opts.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL)

        if opts.get(CONF_SOURCE, DEFAULT_SOURCE) == SOURCE_LOCAL:
            self.source: OpenSkySource | LocalAdsbSource = LocalAdsbSource(
                opts.get(CONF_LOCAL_URL, "")
            )
        else:
            self.source = OpenSkySource(
                opts.get(CONF_OPENSKY_CLIENT_ID),
                opts.get(CONF_OPENSKY_CLIENT_SECRET),
            )

        # callsign -> (timestamp, {departure, arrival, route})
        self._route_cache: dict[str, tuple[float, dict[str, Any]]] = {}

        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=interval),
        )

    def _bbox(self) -> BBox:
        dlat = self.radius / 111.0
        dlon = self.radius / (111.0 * max(math.cos(math.radians(self.latitude)), 0.01))
        return BBox(
            lamin=self.latitude - dlat,
            lamax=self.latitude + dlat,
            lomin=self.longitude - dlon,
            lomax=self.longitude + dlon,
        )

    async def _async_update_data(self) -> list[dict[str, Any]]:
        session = async_get_clientsession(self.hass)
        raw = await self.source.async_fetch(session, self._bbox())

        blips: list[dict[str, Any]] = []
        for ac in raw:
            if ac.get("on_ground"):
                continue
            distance = _haversine_km(
                self.latitude, self.longitude, ac["lat"], ac["lon"]
            )
            if distance > self.radius:
                continue
            bearing = _bearing_deg(
                self.latitude, self.longitude, ac["lat"], ac["lon"]
            )
            alt_m = ac.get("altitude_m")
            speed_mps = ac.get("speed_mps")
            vrate_mps = ac.get("vertical_rate_mps")
            blips.append(
                {
                    "address": ac.get("icao24") or ac.get("callsign") or "?",
                    "name": ac.get("callsign") or ac.get("icao24") or "?",
                    "icao24": ac.get("icao24"),
                    "country": ac.get("origin_country"),
                    "distance": round(distance, 1),
                    "angle": round(bearing, 1),
                    "heading": round(ac["track"]) if ac.get("track") is not None else None,
                    "altitude": round(alt_m * M_TO_FT) if alt_m is not None else None,
                    "speed": round(speed_mps * MPS_TO_KT) if speed_mps is not None else None,
                    "vertical_rate": round(vrate_mps * MPS_TO_FTMIN)
                    if vrate_mps is not None
                    else None,
                    "squawk": ac.get("squawk"),
                    "lat": round(ac["lat"], 4),
                    "lon": round(ac["lon"], 4),
                }
            )
        blips.sort(key=lambda b: b["distance"])
        return blips

    async def async_get_route(self, callsign: str) -> dict[str, Any]:
        """Return {departure, arrival, route} for a callsign (cached)."""
        callsign = (callsign or "").strip()
        if not callsign:
            return {}
        cached = self._route_cache.get(callsign)
        if cached and (time.time() - cached[0]) < ROUTE_CACHE_TTL:
            return cached[1]
        session = async_get_clientsession(self.hass)
        route = await self.source.async_route(session, callsign)
        self._route_cache[callsign] = (time.time(), route)
        return route

    def snapshot(self) -> dict[str, Any]:
        return {
            "now": time.time(),
            "config": {
                "mode": "flights",
                "unit": "km",
                "max_distance": self.radius,
                "center": {"lat": self.latitude, "lon": self.longitude},
            },
            "devices": self.data or [],
        }
