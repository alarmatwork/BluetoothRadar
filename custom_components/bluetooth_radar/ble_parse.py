"""Best-effort decoding of BLE advertisement data into human-friendly info.

Everything here is defensive: unknown company IDs / service UUIDs fall back to
their raw hex, and malformed payloads simply return None. All outputs are JSON
serialisable so they can go straight over the WebSocket to the card.
"""

from __future__ import annotations

from typing import Any

# A small, high-confidence subset of Bluetooth SIG "Company Identifiers".
# Unknown IDs are shown as raw hex rather than guessed.
COMPANY_NAMES: dict[int, str] = {
    0x004C: "Apple",
    0x0006: "Microsoft",
    0x00E0: "Google",
    0x0075: "Samsung",
    0x0087: "Garmin",
    0x0157: "Huami (Amazfit/Xiaomi)",
    0x0171: "Amazon",
    0x05A7: "Sonos",
    0x00D2: "Qualcomm",
    0x004F: "Logitech",
    0x0059: "Nordic Semiconductor",
    0x0822: "Adafruit",
    0x0499: "Ruuvi",
}

# Common 16-bit service UUIDs (SIG-assigned + a few well-known vendor ones).
SERVICE_NAMES: dict[int, str] = {
    0x1800: "Generic Access",
    0x1801: "Generic Attribute",
    0x1809: "Health Thermometer",
    0x180A: "Device Information",
    0x180D: "Heart Rate",
    0x180F: "Battery",
    0x181A: "Environmental Sensing",
    0xFD6F: "Exposure Notification",
    0xFE9F: "Google",
    0xFEAA: "Eddystone",
    0xFEED: "Tile",
    0xFE95: "Xiaomi",
}

_APPLE_COMPANY_ID = 0x004C
_EDDYSTONE_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"

_EDDYSTONE_SCHEMES = ["http://www.", "https://www.", "http://", "https://"]
_EDDYSTONE_EXPANSIONS = [
    ".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/",
    ".com", ".org", ".edu", ".net", ".info", ".biz", ".gov",
]


def _short_uuid(uuid: str) -> int | None:
    """Return the 16-bit short form of a standard-base UUID, else None."""
    u = uuid.lower()
    if u.endswith("-0000-1000-8000-00805f9b34fb") and u.startswith("0000"):
        try:
            return int(u[4:8], 16)
        except ValueError:
            return None
    return None


def company_label(company_id: int) -> str:
    name = COMPANY_NAMES.get(company_id)
    return f"{name} (0x{company_id:04X})" if name else f"0x{company_id:04X}"


def best_manufacturer(manufacturer_data: dict[int, bytes]) -> str | None:
    if not manufacturer_data:
        return None
    return company_label(next(iter(manufacturer_data)))


def company_ids(manufacturer_data: dict[int, bytes]) -> list[str]:
    return [company_label(cid) for cid in (manufacturer_data or {})]


def service_labels(service_uuids: list[str]) -> list[str]:
    labels: list[str] = []
    for uuid in service_uuids or []:
        short = _short_uuid(uuid)
        if short is not None and short in SERVICE_NAMES:
            labels.append(f"{SERVICE_NAMES[short]} (0x{short:04X})")
        elif short is not None:
            labels.append(f"0x{short:04X}")
        else:
            labels.append(uuid)
    return labels


def address_kind(address: str) -> str:
    """Heuristic public-vs-random from the locally-administered bit."""
    try:
        first = int(address.split(":")[0], 16)
    except (ValueError, IndexError):
        return "unknown"
    return "random (likely)" if first & 0x02 else "public (likely)"


def parse_ibeacon(manufacturer_data: dict[int, bytes]) -> dict[str, Any] | None:
    data = (manufacturer_data or {}).get(_APPLE_COMPANY_ID)
    if not data or len(data) < 23 or data[0] != 0x02 or data[1] != 0x15:
        return None
    raw = data[2:18].hex()
    uuid = f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"
    return {
        "uuid": uuid,
        "major": int.from_bytes(data[18:20], "big"),
        "minor": int.from_bytes(data[20:22], "big"),
        "power": int.from_bytes(data[22:23], "big", signed=True),
    }


def parse_eddystone_url(service_data: dict[str, bytes]) -> str | None:
    data = (service_data or {}).get(_EDDYSTONE_UUID)
    if not data or len(data) < 3 or data[0] != 0x10:  # 0x10 = URL frame
        return None
    scheme = data[2]
    if scheme >= len(_EDDYSTONE_SCHEMES):
        return None
    url = _EDDYSTONE_SCHEMES[scheme]
    for byte in data[3:]:
        if byte < len(_EDDYSTONE_EXPANSIONS):
            url += _EDDYSTONE_EXPANSIONS[byte]
        elif 0x20 <= byte < 0x7F:
            url += chr(byte)
        else:
            return None
    return url
