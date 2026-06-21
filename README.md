# Bluetooth Radar for Home Assistant

A retro, green-phosphor CRT **flight-radar screen** for Home Assistant — but
instead of aircraft, the blips are the Bluetooth LE devices your ESPHome
`bluetooth_proxy` hears. A sweep line rotates around the scope, lighting up
each device as it passes.

It has two parts:

| Part | What it is | Folder |
|------|------------|--------|
| **Integration** | A custom component that listens to every BLE advertisement passing through your Bluetooth proxies, estimates distance from RSSI, and streams live snapshots to the card over a WebSocket. | `custom_components/bluetooth_radar/` |
| **Lovelace card** | A canvas-drawn radar display. | `www/bluetooth-radar-card.js` |

## How it works (and an honest caveat)

A single Bluetooth proxy reports **RSSI** (signal strength) for each device it
hears. RSSI gives a usable *distance estimate* via the log-distance path-loss
model:

```
distance = 10 ^ ((measured_power − rssi) / (10 × path_loss_exponent))
```

But **one receiver cannot measure direction.** So on the radar:

- **Distance from the centre is real** — derived from RSSI.
- **The bearing (angle) is synthetic** — a stable value hashed from each
  device's MAC address, so a device always sits in the same spot rather than
  jumping around. It does *not* mean the device is physically in that
  direction.

Distance estimates from RSSI are noisy by nature (walls, orientation, and radio
reflections all affect it). Treat the rings as "near / medium / far," not a
tape measure. If you ever add multiple proxies, true positioning is what
[Bermuda-style trilateration](https://github.com/agittins/bermuda) does — this
card is the playful single-receiver cousin.

## Prerequisites

- Home Assistant with the **Bluetooth** integration enabled.
- At least one Bluetooth source feeding it — your ESPHome Atom config already
  does this:

  ```yaml
  esphome:
    name: atom-sensors
  bluetooth_proxy:
    active: true
  esp32_ble_tracker:
    scan_parameters:
      active: true
  ```

  Active scanning is recommended so you capture more devices and `tx_power`.

## Installation

### 1. Integration (backend)

Copy `custom_components/bluetooth_radar/` into your HA config directory:

```
<config>/custom_components/bluetooth_radar/
```

Restart Home Assistant, then go to **Settings → Devices & Services → Add
Integration → Bluetooth Radar**. You'll be asked for:

| Option | Default | Meaning |
|--------|---------|---------|
| Measured power | `-59` dBm | RSSI at 1 m from a reference device. Lower (more negative) ⇒ devices read as further away. |
| Path-loss exponent | `2.5` | `2.0` = open space, `3–4` = lots of walls. Higher ⇒ distance grows faster. |
| Outer range | `15` m | The outermost radar ring. |
| Drop after | `60` s | Remove a device not heard from in this long. |

These can be retuned anytime via the integration's **Configure** button — no
restart needed.

### 2. Card (frontend)

Copy `www/bluetooth-radar-card.js` into your HA config:

```
<config>/www/bluetooth-radar-card.js
```

Add it as a Lovelace resource (**Settings → Dashboards → ⋮ → Resources →
Add**):

```
URL:  /local/bluetooth-radar-card.js
Type: JavaScript Module
```

Then add the card to a dashboard:

```yaml
type: custom:bluetooth-radar-card
title: Bluetooth Radar
# optional overrides:
# max_distance: 15      # outer ring in metres (defaults to integration setting)
# sweep_seconds: 4      # seconds per full sweep revolution
# show_labels: true     # device name + distance next to each blip
# name_filter: "iphone" # only show devices whose name contains this
```

> **HACS:** this repo also works as a custom HACS repository (integration +
> Lovelace plugin). Add it as a custom repository if you prefer managed
> updates.

## Deploying to your NAS

Only **two paths** ever need to land on the HA box; everything else in this
repo (`README.md`, `hacs.json`) is just for development/HACS:

| From this repo | To on the HA host |
|----------------|-------------------|
| `custom_components/bluetooth_radar/` | `<config>/custom_components/bluetooth_radar/` |
| `www/bluetooth-radar-card.js` | `<config>/www/bluetooth-radar-card.js` |

`<config>` is the directory that holds your `configuration.yaml` (on HA OS /
Supervised it's `/config`; on a bare container it's whatever you mounted, e.g.
`/volume1/docker/homeassistant`).

### Recommended: SSH + rsync (best while you're iterating)

Fast, no remote repo needed, and re-deploys a tweak in about a second. Enable
the **SSH / Terminal** add-on (HA OS) or SSH into the NAS, then from this repo:

```bash
# set these once
HA=root@homeassistant.local          # user@host of your NAS / HA box
CFG=/config                          # the directory holding configuration.yaml

# push both pieces
rsync -avz --delete custom_components/bluetooth_radar/ \
    "$HA:$CFG/custom_components/bluetooth_radar/"
rsync -avz www/bluetooth-radar-card.js \
    "$HA:$CFG/www/bluetooth-radar-card.js"
```

`--delete` keeps the integration folder an exact mirror (removes files you
deleted locally). Don't put `--delete` on the `www` copy — that folder holds
other people's resources too.

After pushing:

- **Changed the integration (Python):** restart Home Assistant (or reload the
  integration) so it re-imports.
- **Changed only the card (JS):** just hard-refresh the browser
  (Ctrl/Cmd-Shift-R). Bump the resource URL to `…card.js?v=2` if HA caches the
  old one.

No SSH? The HA **Samba** add-on exposes the same `config` share — drag the two
items into `custom_components/` and `www/` over the network instead.

### Alternative: git + HACS (best once it's stable)

Good for hands-off updates, but more setup: push this repo to GitHub, then in
HACS add it as a **custom repository**. Notes:

- HACS installs the **integration** into `custom_components/` and registers the
  **card** as a Lovelace resource automatically — but you still restart HA
  after integration updates.
- Tag releases (`git tag v1.0.0 && git push --tags`) so HACS sees versions.

For a private, actively-developed project, SSH/rsync is the lower-friction
choice; reach for HACS when you want it to update itself.

## Tuning tips

- Devices appearing too close/too far? Adjust **measured power** first, then
  **path-loss exponent**.
- A crowded scope? Use `name_filter`, or lower **Drop after** so absent devices
  vanish quicker.
- Unknown-distance devices (no RSSI) are parked on the outer ring.

## Data flow

```
ESP32 bluetooth_proxy ─BLE adv─▶ HA Bluetooth integration
        └▶ bluetooth_radar (async_register_callback)
              └▶ snapshot every 1s ─WebSocket(bluetooth_radar/subscribe)─▶ card
                    └▶ canvas radar: sweep + blips
```

## Project layout

```
custom_components/bluetooth_radar/
  __init__.py        setup / teardown
  manifest.json      depends on the `bluetooth` integration
  const.py           defaults & option keys
  config_flow.py     UI setup + options
  radar.py           advertisement tracker, distance model, snapshots
  websocket_api.py   bluetooth_radar/list + /subscribe commands
  translations/en.json
www/
  bluetooth-radar-card.js   the radar Lovelace card
```

## License

MIT.
