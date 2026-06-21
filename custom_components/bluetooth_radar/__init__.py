"""The Bluetooth Radar integration."""

from __future__ import annotations

import logging

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import websocket_api
from .const import DOMAIN
from .radar import BluetoothRadarManager

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Bluetooth Radar from a config entry."""
    manager = BluetoothRadarManager(hass, entry)
    await manager.async_start()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = manager
    websocket_api.async_register(hass)

    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    manager: BluetoothRadarManager = hass.data[DOMAIN].pop(entry.entry_id)
    await manager.async_stop()
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Apply changed options without a restart."""
    manager: BluetoothRadarManager = hass.data[DOMAIN][entry.entry_id]
    manager.update_options(entry.options)
