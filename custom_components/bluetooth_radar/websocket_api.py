"""WebSocket API exposing live radar snapshots to the Lovelace card."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .radar import BluetoothRadarManager

_WS_REGISTERED = f"{DOMAIN}_ws_registered"


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the radar WebSocket commands (idempotent)."""
    if hass.data.get(_WS_REGISTERED):
        return
    hass.data[_WS_REGISTERED] = True
    websocket_api.async_register_command(hass, websocket_list)
    websocket_api.async_register_command(hass, websocket_subscribe)


def _get_manager(hass: HomeAssistant) -> BluetoothRadarManager | None:
    for manager in hass.data.get(DOMAIN, {}).values():
        if isinstance(manager, BluetoothRadarManager):
            return manager
    return None


@websocket_api.websocket_command({vol.Required("type"): "bluetooth_radar/list"})
@callback
def websocket_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return a single current snapshot."""
    manager = _get_manager(hass)
    if manager is None:
        connection.send_error(msg["id"], "not_loaded", "Bluetooth Radar not set up")
        return
    connection.send_result(msg["id"], manager.snapshot())


@websocket_api.websocket_command({vol.Required("type"): "bluetooth_radar/subscribe"})
@callback
def websocket_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Stream radar snapshots to the client until unsubscribed."""
    manager = _get_manager(hass)
    if manager is None:
        connection.send_error(msg["id"], "not_loaded", "Bluetooth Radar not set up")
        return

    @callback
    def _forward(snapshot: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], snapshot))

    connection.subscriptions[msg["id"]] = manager.async_add_listener(_forward)
    connection.send_result(msg["id"])
    _forward(manager.snapshot())
