"""WebSocket API exposing live flight snapshots to the radar card."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .coordinator import FlightRadarCoordinator

_WS_REGISTERED = f"{DOMAIN}_ws_registered"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the flight radar WebSocket commands (idempotent)."""
    if hass.data.get(_WS_REGISTERED):
        return
    hass.data[_WS_REGISTERED] = True
    websocket_api.async_register_command(hass, websocket_list)
    websocket_api.async_register_command(hass, websocket_subscribe)
    websocket_api.async_register_command(hass, websocket_route)


def _get_coordinator(hass: HomeAssistant) -> FlightRadarCoordinator | None:
    for coordinator in hass.data.get(DOMAIN, {}).values():
        if isinstance(coordinator, FlightRadarCoordinator):
            return coordinator
    return None


@websocket_api.websocket_command({vol.Required("type"): "flight_radar/list"})
@callback
def websocket_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return a single current snapshot."""
    coordinator = _get_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Flight Radar not set up")
        return
    connection.send_result(msg["id"], coordinator.snapshot())


@websocket_api.websocket_command({vol.Required("type"): "flight_radar/subscribe"})
@callback
def websocket_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Stream flight snapshots to the client until unsubscribed."""
    coordinator = _get_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Flight Radar not set up")
        return

    @callback
    def _forward() -> None:
        connection.send_message(
            websocket_api.event_message(msg["id"], coordinator.snapshot())
        )

    connection.subscriptions[msg["id"]] = coordinator.async_add_listener(_forward)
    connection.send_result(msg["id"])
    _forward()


@websocket_api.websocket_command(
    {
        vol.Required("type"): "flight_radar/route",
        vol.Required("callsign"): str,
    }
)
@websocket_api.async_response
async def websocket_route(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Look up departure/arrival airports for a callsign (best-effort)."""
    coordinator = _get_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Flight Radar not set up")
        return
    route = await coordinator.async_get_route(msg["callsign"])
    connection.send_result(msg["id"], route)
