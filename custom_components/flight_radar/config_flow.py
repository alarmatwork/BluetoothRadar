"""Config and options flow for Flight Radar."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    OptionsFlow,
)
from homeassistant.core import HomeAssistant, callback
from homeassistant.data_entry_flow import FlowResult

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
    DEFAULT_SOURCE,
    DEFAULT_UPDATE_INTERVAL,
    DOMAIN,
    SOURCE_LOCAL,
    SOURCE_OPENSKY,
)


def _schema(hass: HomeAssistant, data: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_LATITUDE,
                default=data.get(CONF_LATITUDE, hass.config.latitude),
            ): vol.Coerce(float),
            vol.Required(
                CONF_LONGITUDE,
                default=data.get(CONF_LONGITUDE, hass.config.longitude),
            ): vol.Coerce(float),
            vol.Required(
                CONF_RADIUS,
                default=data.get(CONF_RADIUS, DEFAULT_RADIUS),
            ): vol.All(vol.Coerce(float), vol.Range(min=1.0, max=500.0)),
            vol.Required(
                CONF_UPDATE_INTERVAL,
                default=data.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL),
            ): vol.All(vol.Coerce(int), vol.Range(min=5, max=600)),
            vol.Required(
                CONF_SOURCE,
                default=data.get(CONF_SOURCE, DEFAULT_SOURCE),
            ): vol.In({SOURCE_OPENSKY: "OpenSky Network", SOURCE_LOCAL: "Local ADS-B receiver"}),
            vol.Optional(
                CONF_OPENSKY_CLIENT_ID,
                default=data.get(CONF_OPENSKY_CLIENT_ID, ""),
            ): str,
            vol.Optional(
                CONF_OPENSKY_CLIENT_SECRET,
                default=data.get(CONF_OPENSKY_CLIENT_SECRET, ""),
            ): str,
            vol.Optional(
                CONF_LOCAL_URL,
                default=data.get(CONF_LOCAL_URL, ""),
            ): str,
        }
    )


def _validate(user_input: dict[str, Any]) -> dict[str, str]:
    errors: dict[str, str] = {}
    if user_input[CONF_SOURCE] == SOURCE_LOCAL and not user_input.get(CONF_LOCAL_URL):
        errors[CONF_LOCAL_URL] = "local_url_required"
    return errors


class FlightRadarConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the initial setup."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(
                    title="Flight Radar", data={}, options=user_input
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_schema(self.hass, user_input or {}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return FlightRadarOptionsFlow(config_entry)


class FlightRadarOptionsFlow(OptionsFlow):
    """Handle option changes after setup."""

    def __init__(self, config_entry: ConfigEntry) -> None:
        self._entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = _validate(user_input)
            if not errors:
                return self.async_create_entry(title="", data=user_input)

        data = user_input or dict(self._entry.options)
        return self.async_show_form(
            step_id="init",
            data_schema=_schema(self.hass, data),
            errors=errors,
        )
