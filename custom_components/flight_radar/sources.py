"""Flight data sources for the Flight Radar integration.

Each source returns a list of *normalised* aircraft dicts:

    {
        "icao24": str | None,
        "callsign": str,
        "lat": float,
        "lon": float,
        "altitude_m": float | None,
        "speed_mps": float | None,
        "track": float | None,   # degrees, 0 = north, clockwise
        "on_ground": bool,
    }

Distance/bearing relative to the radar centre are computed later by the
coordinator, so sources only deal with fetching + normalising.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import aiohttp
from homeassistant.helpers.update_coordinator import UpdateFailed

_LOGGER = logging.getLogger(__name__)

OPENSKY_STATES_URL = "https://opensky-network.org/api/states/all"
OPENSKY_ROUTES_URL = "https://opensky-network.org/api/routes"
OPENSKY_TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network/"
    "protocol/openid-connect/token"
)


@dataclass
class BBox:
    """Bounding box in degrees."""

    lamin: float
    lamax: float
    lomin: float
    lomax: float


class OpenSkySource:
    """Fetch aircraft from the OpenSky Network REST API."""

    def __init__(self, client_id: str | None, client_secret: str | None) -> None:
        self._client_id = client_id or None
        self._client_secret = client_secret or None
        self._token: str | None = None
        self._token_expires = 0.0

    @property
    def has_credentials(self) -> bool:
        return bool(self._client_id and self._client_secret)

    async def _async_token(self, session: aiohttp.ClientSession) -> str | None:
        if not self.has_credentials:
            return None
        if self._token and time.time() < self._token_expires - 30:
            return self._token
        data = {
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }
        try:
            async with session.post(OPENSKY_TOKEN_URL, data=data, timeout=15) as resp:
                resp.raise_for_status()
                payload = await resp.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"OpenSky auth failed: {err}") from err
        self._token = payload["access_token"]
        self._token_expires = time.time() + payload.get("expires_in", 1800)
        return self._token

    async def async_fetch(
        self, session: aiohttp.ClientSession, bbox: BBox
    ) -> list[dict]:
        token = await self._async_token(session)
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        params = {
            "lamin": round(bbox.lamin, 4),
            "lamax": round(bbox.lamax, 4),
            "lomin": round(bbox.lomin, 4),
            "lomax": round(bbox.lomax, 4),
        }
        try:
            async with session.get(
                OPENSKY_STATES_URL, params=params, headers=headers, timeout=20
            ) as resp:
                if resp.status == 429:
                    raise UpdateFailed(
                        "OpenSky rate-limited (HTTP 429). Add OpenSky credentials "
                        "or increase the update interval."
                    )
                resp.raise_for_status()
                payload = await resp.json()
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"OpenSky request failed: {err}") from err

        states = payload.get("states") or []
        aircraft: list[dict] = []
        for s in states:
            lon, lat = s[5], s[6]
            if lat is None or lon is None:
                continue
            aircraft.append(
                {
                    "icao24": s[0],
                    "callsign": (s[1] or "").strip(),
                    "origin_country": s[2],
                    "lat": lat,
                    "lon": lon,
                    "altitude_m": s[13] if s[13] is not None else s[7],
                    "speed_mps": s[9],
                    "track": s[10],
                    "vertical_rate_mps": s[11],
                    "squawk": s[14],
                    "on_ground": bool(s[8]),
                }
            )
        return aircraft

    async def async_route(
        self, session: aiohttp.ClientSession, callsign: str
    ) -> dict:
        """Best-effort departure/arrival airport lookup for a callsign.

        Uses OpenSky's /routes endpoint, which is separate from the live feed
        and not always available — any failure returns {} so the UI degrades
        gracefully to an external link.
        """
        callsign = (callsign or "").strip()
        if not callsign:
            return {}
        try:
            token = await self._async_token(session)
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            async with session.get(
                OPENSKY_ROUTES_URL,
                params={"callsign": callsign},
                headers=headers,
                timeout=15,
            ) as resp:
                if resp.status != 200:
                    return {}
                data = await resp.json()
        except (aiohttp.ClientError, UpdateFailed, ValueError):
            return {}
        route = data.get("route") or []
        if not route:
            return {}
        return {"departure": route[0], "arrival": route[-1], "route": route}


class LocalAdsbSource:
    """Fetch aircraft from a local dump1090 / tar1090 / readsb aircraft.json."""

    def __init__(self, url: str) -> None:
        self._url = url

    async def async_fetch(
        self, session: aiohttp.ClientSession, bbox: BBox
    ) -> list[dict]:
        try:
            async with session.get(self._url, timeout=10) as resp:
                resp.raise_for_status()
                payload = await resp.json(content_type=None)
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Local ADS-B request failed: {err}") from err

        aircraft: list[dict] = []
        for a in payload.get("aircraft") or []:
            lat, lon = a.get("lat"), a.get("lon")
            if lat is None or lon is None:
                continue
            alt = a.get("alt_baro")
            alt_m = alt * 0.3048 if isinstance(alt, (int, float)) else None
            gs = a.get("gs")
            speed_mps = gs * 0.514444 if isinstance(gs, (int, float)) else None
            baro_rate = a.get("baro_rate")  # ft/min in tar1090
            aircraft.append(
                {
                    "icao24": a.get("hex"),
                    "callsign": (a.get("flight") or "").strip(),
                    "origin_country": None,
                    "lat": lat,
                    "lon": lon,
                    "altitude_m": alt_m,
                    "speed_mps": speed_mps,
                    "track": a.get("track"),
                    # tar1090 baro_rate is already ft/min; convert to m/s so the
                    # coordinator's single conversion path applies.
                    "vertical_rate_mps": baro_rate / 196.850394
                    if isinstance(baro_rate, (int, float))
                    else None,
                    "squawk": a.get("squawk"),
                    "on_ground": alt == "ground",
                }
            )
        return aircraft

    async def async_route(self, session, callsign):  # noqa: D102
        # Local receivers don't provide route info.
        return {}
