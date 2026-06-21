"""Core advertisement tracker for the Bluetooth Radar integration.

A single ESPHome ``bluetooth_proxy`` (or any HA Bluetooth source) reports
RSSI for every BLE advertisement it hears. RSSI lets us *estimate distance*
to a device, but a single receiver cannot determine direction. The radar
therefore plots:

* radius  -> estimated distance from RSSI (real signal)
* angle   -> a stable pseudo-bearing hashed from the device address, so
             each device keeps a consistent spot on the screen (decorative)
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import Any, Callable

from homeassistant.components import bluetooth
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

from .const import (
    CONF_MAX_DISTANCE,
    CONF_MEASURED_POWER,
    CONF_PATH_LOSS,
    CONF_STALE_SECONDS,
    DEFAULT_MAX_DISTANCE,
    DEFAULT_MEASURED_POWER,
    DEFAULT_PATH_LOSS,
    DEFAULT_STALE_SECONDS,
    PUSH_INTERVAL,
)

_LOGGER = logging.getLogger(__name__)


def _stable_angle(address: str) -> float:
    """Map a device address to a stable bearing in degrees [0, 360)."""
    h = 0
    for char in address:
        h = (h * 31 + ord(char)) & 0xFFFFFFFF
    return (h % 3600) / 10.0


def _manufacturer(service_info: bluetooth.BluetoothServiceInfoBleak) -> str | None:
    """Best-effort vendor name from the advertisement."""
    # Newer HA exposes a resolved name; fall back to the company id.
    name = getattr(service_info, "manufacturer", None)
    if name:
        return name
    data = getattr(service_info, "manufacturer_data", None) or {}
    if data:
        company_id = next(iter(data))
        return f"0x{company_id:04X}"
    return None


class BluetoothRadarManager:
    """Tracks every BLE device seen and pushes snapshots to radar cards."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._cancel_callback: Callable[[], None] | None = None
        self._cancel_timer: Callable[[], None] | None = None
        self._listeners: list[Callable[[dict[str, Any]], None]] = []
        self._devices: dict[str, dict[str, Any]] = {}
        self.update_options(entry.options)

    @callback
    def update_options(self, options: dict[str, Any]) -> None:
        """Apply (or re-apply) the user's configured options."""
        self.measured_power = options.get(CONF_MEASURED_POWER, DEFAULT_MEASURED_POWER)
        self.path_loss = options.get(CONF_PATH_LOSS, DEFAULT_PATH_LOSS)
        self.max_distance = options.get(CONF_MAX_DISTANCE, DEFAULT_MAX_DISTANCE)
        self.stale_seconds = options.get(CONF_STALE_SECONDS, DEFAULT_STALE_SECONDS)

    async def async_start(self) -> None:
        """Begin listening for advertisements."""
        self._cancel_callback = bluetooth.async_register_callback(
            self.hass,
            self._on_advertisement,
            bluetooth.BluetoothCallbackMatcher(connectable=False),
            bluetooth.BluetoothScanningMode.ACTIVE,
        )
        # Seed with whatever the Bluetooth integration already knows about.
        for service_info in bluetooth.async_discovered_service_info(
            self.hass, connectable=False
        ):
            self._ingest(service_info)

        self._cancel_timer = async_track_time_interval(
            self.hass, self._tick, timedelta(seconds=PUSH_INTERVAL)
        )

    async def async_stop(self) -> None:
        """Stop listening and release callbacks."""
        if self._cancel_callback is not None:
            self._cancel_callback()
            self._cancel_callback = None
        if self._cancel_timer is not None:
            self._cancel_timer()
            self._cancel_timer = None

    @callback
    def _on_advertisement(
        self,
        service_info: bluetooth.BluetoothServiceInfoBleak,
        change: bluetooth.BluetoothChange,
    ) -> None:
        self._ingest(service_info)

    @callback
    def _ingest(self, service_info: bluetooth.BluetoothServiceInfoBleak) -> None:
        address = service_info.address
        self._devices[address] = {
            "address": address,
            "name": service_info.name or address,
            "rssi": service_info.rssi,
            "tx_power": service_info.tx_power,
            "distance": self._estimate_distance(service_info.rssi),
            "source": service_info.source,
            "manufacturer": _manufacturer(service_info),
            "service_uuids": list(service_info.service_uuids),
            "connectable": service_info.connectable,
            "last_seen": time.time(),
        }

    def _estimate_distance(self, rssi: int | None) -> float | None:
        """Log-distance path-loss model: d = 10 ^ ((P_1m - RSSI) / (10 n))."""
        if rssi is None or rssi == 0:
            return None
        ratio = (self.measured_power - rssi) / (10.0 * self.path_loss)
        return round(10.0**ratio, 2)

    @callback
    def snapshot(self) -> dict[str, Any]:
        """Build the current radar payload, pruning stale devices."""
        now = time.time()
        devices: list[dict[str, Any]] = []
        for address, device in self._devices.items():
            age = now - device["last_seen"]
            if age > self.stale_seconds:
                continue
            item = dict(device)
            item.pop("last_seen", None)
            item["age"] = round(age, 1)
            item["angle"] = _stable_angle(address)
            devices.append(item)
        devices.sort(key=lambda d: (d["distance"] is None, d["distance"] or 0))
        return {
            "now": now,
            "config": {
                "max_distance": self.max_distance,
                "stale_seconds": self.stale_seconds,
            },
            "devices": devices,
        }

    @callback
    def async_add_listener(
        self, listener: Callable[[dict[str, Any]], None]
    ) -> Callable[[], None]:
        """Register a snapshot listener; returns an unsubscribe callable."""
        self._listeners.append(listener)

        def _remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return _remove

    @callback
    def _tick(self, now) -> None:
        if not self._listeners:
            return
        snap = self.snapshot()
        for listener in list(self._listeners):
            listener(snap)
