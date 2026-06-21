# Radar for Home Assistant — Bluetooth & Flights

A retro, green-phosphor CRT **radar screen** for Home Assistant. A sweep line
rotates around the scope, lighting up blips as it passes. It ships **two radar
modes that share one card**:

- 📡 **Bluetooth Radar** — the Bluetooth LE devices your ESPHome
  `bluetooth_proxy` hears, placed by estimated distance from RSSI.
- ✈️ **Flight Radar** — aircraft around a location you choose, placed by **real**
  distance *and* bearing from their GPS positions.

Run either one, or both at once. The component has **three pieces**:

| Piece | What it is | Path |
|-------|------------|------|
| **Bluetooth integration** | Listens to every BLE advertisement through your proxies, estimates distance from RSSI, streams snapshots over a WebSocket. | `custom_components/bluetooth_radar/` |
| **Flight integration** | Polls a flight-data source for a box around your location, computes distance + bearing, streams snapshots over a WebSocket. | `custom_components/flight_radar/` |
| **Lovelace card** | One canvas-drawn radar that renders either mode — registers both `bluetooth-radar-card` and `flight-radar-card`. | `www/bluetooth-radar-card.js` |

Install only the integration(s) you want; the single card file serves both.

## How it works

Both modes push the **same payload shape** to the card
(`{ devices: [{ name, distance, angle, … }] }`), which is why one card renders
either. What differs is how honest each axis is.

### 📡 Bluetooth mode (distance real, bearing synthetic)

A single Bluetooth proxy reports **RSSI** (signal strength) per device. RSSI
gives a usable *distance estimate* via the log-distance path-loss model:

```
distance = 10 ^ ((measured_power − rssi) / (10 × path_loss_exponent))
```

But **one receiver cannot measure direction.** So:

- **Distance from the centre is real** — derived from RSSI.
- **The bearing (angle) is synthetic** — a stable value hashed from each
  device's MAC, so a device always sits in the same spot rather than jumping
  around. It does *not* mean the device is physically in that direction.

RSSI distance is noisy by nature (walls, orientation, reflections). Treat the
rings as "near / medium / far," not a tape measure. For true multi-proxy
positioning, see [Bermuda-style trilateration](https://github.com/agittins/bermuda)
— this is the playful single-receiver cousin.

### ✈️ Flight mode (distance *and* bearing real)

Aircraft broadcast their GPS position, so the flight radar is honest in both
axes: **distance and bearing are both real**, computed (haversine) from your
chosen centre. North is up, and blips are little triangles pointing along each
aircraft's track. Pick where the data comes from:

| Source | Hardware | Notes |
|--------|----------|-------|
| **OpenSky Network** (default) | none | Free cloud API. Works anonymously but is heavily rate-limited; add free **OpenSky OAuth2 client credentials** (client ID + secret) for usable limits. Keep the update interval ≥ ~10 s. |
| **Local ADS-B receiver** | RTL-SDR | Point it at your `aircraft.json` (dump1090 / tar1090 / readsb / PiAware), e.g. `http://<host>/tar1090/data/aircraft.json`. No rate limits, fully local, fastest. |

## Prerequisites

**For Bluetooth Radar:**

- Home Assistant with the **Bluetooth** integration enabled.
- At least one Bluetooth source feeding it — e.g. an ESPHome proxy:

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

**For Flight Radar:**

- Nothing extra for the default **OpenSky** source — though a free OpenSky
  account (for OAuth2 client credentials) is strongly recommended to avoid rate
  limits. *Or* a **local ADS-B receiver** exposing an `aircraft.json` URL.
- Your HA **Home** location set (Settings → System → General) — used as the
  default radar centre. You can override it per radar.

## Installation

The pieces must end up at these exact paths inside your HA config directory (the
folder that contains `configuration.yaml`). Copy **both integrations** plus the
**card** (the integrations are independent — skip one if you don't want that
radar; the card is shared and always needed):

```
<config>/custom_components/bluetooth_radar/    ← Bluetooth integration (Python)
<config>/custom_components/flight_radar/        ← Flight integration (Python)
<config>/www/bluetooth-radar-card.js            ← the dashboard card (JS, both modes)
```

> On HA OS / Supervised, or in the **Terminal & SSH** add-on, `<config>` is
> **`/config`**. On a bare Docker container it's whatever you mounted (e.g.
> `/volume1/docker/homeassistant`). Confirm with `ls <config>` — you should see
> `configuration.yaml`.

Pick **one** of the methods below.

### Step 1 — Get the files onto Home Assistant

#### Method A — Git checkout (recommended)

Open the HA **Terminal & SSH** add-on (or SSH into the host), then:

```bash
cd /config                                   # your HA config dir

# clone into a source folder (NOT directly into custom_components/)
git clone https://github.com/alarmatwork/BluetoothRadar.git bluetooth-radar-src

# make sure the target folders exist
mkdir -p custom_components www

# link the three pieces into the spots HA reads from
ln -s ../bluetooth-radar-src/custom_components/bluetooth_radar custom_components/bluetooth_radar
ln -s ../bluetooth-radar-src/custom_components/flight_radar    custom_components/flight_radar
ln -s ../bluetooth-radar-src/www/bluetooth-radar-card.js       www/bluetooth-radar-card.js
```

> ⚠️ Don't `git clone` *directly into* `custom_components/` — you'd get
> `custom_components/BluetoothRadar/custom_components/bluetooth_radar/…` (nested
> wrong) and HA won't find it. Clone into `bluetooth-radar-src` and link/copy as
> shown.

If `git` is missing, `apk add git` usually works in the add-on. If symlinks
aren't picked up in your setup, **copy instead** (use `rm -rf` first when
updating, so no stale files remain):

```bash
rm -rf /config/custom_components/bluetooth_radar /config/custom_components/flight_radar
cp -r bluetooth-radar-src/custom_components/bluetooth_radar /config/custom_components/
cp -r bluetooth-radar-src/custom_components/flight_radar    /config/custom_components/
cp    bluetooth-radar-src/www/bluetooth-radar-card.js       /config/www/
```

(Drop the `flight_radar` lines if you only want the Bluetooth radar, or the
`bluetooth_radar` lines if you only want flights.)

**Updating later:** `cd /config/bluetooth-radar-src && git pull`, then restart HA
(for integration changes) or hard-refresh the browser (for card-only changes).
Or run the bundled [`update.sh`](update.sh) (pulls, then copies the integrations
and card into HA; `./update.sh --restart` also restarts HA).

#### Method B — Manual copy / rsync

Copy the same three paths from this repo into `<config>/custom_components/` and
`<config>/www/`. See [Deploying to your NAS](#deploying-to-your-nas) for ready
made `rsync` commands.

### Step 2 — Set up the integration(s)

**Restart Home Assistant first** (Settings → System → ⋮ → **Restart**) so it
picks up the new `custom_components` folders. Then add whichever radar(s) you
want via **Settings → Devices & Services → Add Integration**. Both store their
settings in the UI — no `configuration.yaml` editing — and both can be retuned
later via the integration's **Configure** button (Flight Radar reloads
automatically).

#### Step 2a — Bluetooth Radar

Add Integration → **Bluetooth Radar**:

| Option | Default | Meaning |
|--------|---------|---------|
| Measured power | `-59` dBm | RSSI at 1 m from a reference device. Lower (more negative) ⇒ devices read as further away. |
| Path-loss exponent | `2.5` | `2.0` = open space, `3–4` = lots of walls. Higher ⇒ distance grows faster. |
| Outer range | `15` m | The outermost radar ring. |
| Drop after | `60` s | Remove a device not heard from in this long. |

#### Step 2b — Flight Radar

Add Integration → **Flight Radar**:

| Option | Default | Meaning |
|--------|---------|---------|
| Centre latitude / longitude | your HA **Home** location | Where the radar is centred. Change to watch any spot. |
| Radar range | `100` km | The outermost radar ring. |
| Update interval | `15` s | Poll cadence. Lower only with a local receiver. |
| Data source | OpenSky | `OpenSky Network` or `Local ADS-B receiver`. |
| OpenSky client ID / secret | empty | Optional, but strongly recommended for OpenSky. |
| Local ADS-B URL | empty | Required when source = local (e.g. `http://<host>/tar1090/data/aircraft.json`). |

### Step 3 — Register the card as a Lovelace resource

Register the card's JS file **once** — this single resource provides *both* the
`bluetooth-radar-card` and `flight-radar-card` elements.

- **UI / "storage" mode dashboards (the default):**
  **Settings → Dashboards → ⋮ (top right) → Resources → Add Resource:**

  ```
  URL:  /local/bluetooth-radar-card.js
  Type: JavaScript Module
  ```

  (`/local/` maps to `<config>/www/`.) After saving, **hard-refresh** your
  browser (Ctrl/Cmd-Shift-R).

  > Don't see a **Resources** menu? Enable **Advanced Mode** in your user
  > profile (bottom-left avatar → toggle **Advanced Mode**).

- **YAML-mode dashboards only:** add it under `lovelace:` in
  `configuration.yaml` instead:

  ```yaml
  lovelace:
    resources:
      - url: /local/bluetooth-radar-card.js
        type: module
  ```

### Step 4 — Add the card(s) to a dashboard

1. Open the dashboard, click the ✏️ **pencil (Edit dashboard)** → **+ Add Card**.
2. Scroll to the bottom and choose **Manual** (or search the picker for
   "Bluetooth Radar Card" / "Flight Radar Card").
3. Paste the card for the radar you set up and click **Save**:

   **Bluetooth:**

   ```yaml
   type: custom:bluetooth-radar-card
   title: Bluetooth Radar
   # optional overrides:
   # size: 600             # max scope width in px (default: fills the column)
   # max_distance: 15      # outer ring in metres (defaults to integration setting)
   # sweep_seconds: 4      # seconds per full sweep revolution
   # show_labels: true     # name + distance next to each blip
   # name_filter: "iphone" # only show devices whose name contains this
   ```

   **Flights:**

   ```yaml
   type: custom:flight-radar-card
   title: Flight Radar
   # optional overrides:
   # size: 600             # max scope width in px (default: fills the column)
   # max_distance: 100     # outer ring in km (defaults to integration range)
   # sweep_seconds: 4
   # show_labels: true     # callsign + altitude + distance
   # name_filter: "RYR"    # e.g. only Ryanair callsigns
   ```

You should see a green radar scope with a rotating sweep, and blips appearing
within a few seconds. The header shows a live count.

> Both cards are the **same code** with different defaults. You can also write
> `type: custom:bluetooth-radar-card` with `mode: flights` (or vice-versa) — the
> `mode:` option wins.

**Quick troubleshooting:**

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Custom element doesn't exist: …-radar-card` | Resource not registered (Step 3) or browser cached — hard-refresh, or add `?v=2` to the resource URL. |
| Card shows "integration not found" | That radar's integration isn't added/loaded (Step 2) — check it appears under Devices & Services. |
| **(BT)** sweep spins but no blips | No BLE devices in range, or your proxy isn't feeding HA. Check **Settings → Devices & Services → Bluetooth** sees advertisements. |
| **(BT)** blips all on the outer ring | Devices report no RSSI, or `max_distance` too small — raise it, or tune **measured power**. |
| **(Flights)** empty / sparse scope | Anonymous OpenSky rate-limiting, no traffic overhead, or range too small. Add OpenSky credentials, raise range, or check HA logs for `flight_radar` errors. |
| **(Flights)** blips appear then vanish each poll | Normal — they re-light as the sweep passes, and refresh on each poll (default 15 s). |

> **HACS:** this repo also works as a custom HACS repository (integration +
> Lovelace plugin). Add it as a custom repository if you prefer managed
> updates — HACS installs the integration and registers the card resource for
> you (you still restart HA after integration updates).

## Deploying to your NAS

Only these paths need to land on the HA box; everything else in this repo
(`README.md`, `hacs.json`) is just for development/HACS:

| From this repo | To on the HA host |
|----------------|-------------------|
| `custom_components/bluetooth_radar/` | `<config>/custom_components/bluetooth_radar/` |
| `custom_components/flight_radar/` | `<config>/custom_components/flight_radar/` |
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

# push the pieces (drop a line for any radar you don't want)
rsync -avz --delete custom_components/bluetooth_radar/ \
    "$HA:$CFG/custom_components/bluetooth_radar/"
rsync -avz --delete custom_components/flight_radar/ \
    "$HA:$CFG/custom_components/flight_radar/"
rsync -avz www/bluetooth-radar-card.js \
    "$HA:$CFG/www/bluetooth-radar-card.js"
```

`--delete` keeps each integration folder an exact mirror (removes files you
deleted locally). Don't put `--delete` on the `www` copy — that folder holds
other people's resources too.

After pushing:

- **Changed the integration (Python):** restart Home Assistant (or reload the
  integration) so it re-imports.
- **Changed only the card (JS):** just hard-refresh the browser
  (Ctrl/Cmd-Shift-R). Bump the resource URL to `…card.js?v=2` if HA caches the
  old one.

No SSH? The HA **Samba** add-on exposes the same `config` share — drag the
folders into `custom_components/` and the card into `www/` over the network
instead.

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

**Bluetooth:**

- Devices appearing too close/too far? Adjust **measured power** first, then
  **path-loss exponent**.
- A crowded scope? Use `name_filter`, or lower **Drop after** so absent devices
  vanish quicker.
- Unknown-distance devices (no RSSI) are parked on the outer ring.

**Flights:**

- Empty/sparse scope on OpenSky? You're almost certainly being rate-limited —
  add OpenSky credentials and/or raise the update interval.
- Watch a different area by changing the centre **latitude/longitude**; widen or
  narrow with **range**.
- Use `name_filter` to follow a single airline/callsign prefix.

## Data flow

```
Bluetooth:
  ESP32 bluetooth_proxy ─BLE adv─▶ HA Bluetooth integration
        └▶ bluetooth_radar (async_register_callback)
              └▶ snapshot 1s ─WS(bluetooth_radar/subscribe)─▶ card

Flights:
  OpenSky API / local aircraft.json ─poll─▶ flight_radar coordinator
        └▶ distance + bearing from centre
              └▶ snapshot ─WS(flight_radar/subscribe)─▶ card
```

Both push the **same payload shape** (`{ devices: [{ name, distance, angle,
… }] }`), which is why one card renders either.

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
custom_components/flight_radar/
  __init__.py        setup / teardown
  manifest.json
  const.py           defaults & option keys
  config_flow.py     UI setup + options (location, range, source, creds)
  sources.py         OpenSky + local ADS-B fetchers
  coordinator.py     polling + haversine distance / bearing, snapshots
  websocket_api.py   flight_radar/list + /subscribe commands
  translations/en.json
www/
  bluetooth-radar-card.js   one file → bluetooth-radar-card + flight-radar-card
```

## License

MIT.
