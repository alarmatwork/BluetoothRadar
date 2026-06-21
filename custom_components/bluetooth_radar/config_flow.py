"""Config and options flow for Bluetooth Radar."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    OptionsFlow,
)
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult

from .const import (
    CONF_MAX_DISTANCE,
    CONF_MEASURED_POWER,
    CONF_PATH_LOSS,
    CONF_STALE_SECONDS,
    DEFAULT_MAX_DISTANCE,
    DEFAULT_MEASURED_POWER,
    DEFAULT_PATH_LOSS,
    DEFAULT_STALE_SECONDS,
    DOMAIN,
)


def _options_schema(options: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_MEASURED_POWER,
                default=options.get(CONF_MEASURED_POWER, DEFAULT_MEASURED_POWER),
            ): vol.All(vol.Coerce(int), vol.Range(min=-120, max=0)),
            vol.Required(
                CONF_PATH_LOSS,
                default=options.get(CONF_PATH_LOSS, DEFAULT_PATH_LOSS),
            ): vol.All(vol.Coerce(float), vol.Range(min=1.0, max=6.0)),
            vol.Required(
                CONF_MAX_DISTANCE,
                default=options.get(CONF_MAX_DISTANCE, DEFAULT_MAX_DISTANCE),
            ): vol.All(vol.Coerce(float), vol.Range(min=1.0, max=200.0)),
            vol.Required(
                CONF_STALE_SECONDS,
                default=options.get(CONF_STALE_SECONDS, DEFAULT_STALE_SECONDS),
            ): vol.All(vol.Coerce(int), vol.Range(min=5, max=600)),
        }
    )


class BluetoothRadarConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(
                title="Bluetooth Radar", data={}, options=user_input
            )

        return self.async_show_form(
            step_id="user", data_schema=_options_schema({})
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return BluetoothRadarOptionsFlow(config_entry)


class BluetoothRadarOptionsFlow(OptionsFlow):
    """Handle option changes after setup."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        return self.async_show_form(
            step_id="init",
            data_schema=_options_schema(dict(self._entry.options)),
        )
