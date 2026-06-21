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

This add-on has **two parts** that must end up at these exact paths inside your
HA config directory (the folder that contains `configuration.yaml`):

```
<config>/custom_components/bluetooth_radar/    ← the integration (Python)
<config>/www/bluetooth-radar-card.js           ← the dashboard card (JS)
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

# link the two pieces into the spots HA reads from
ln -s ../bluetooth-radar-src/custom_components/bluetooth_radar custom_components/bluetooth_radar
ln -s ../bluetooth-radar-src/www/bluetooth-radar-card.js www/bluetooth-radar-card.js
```

> ⚠️ Don't `git clone` *directly into* `custom_components/` — you'd get
> `custom_components/BluetoothRadar/custom_components/bluetooth_radar/…` (nested
> wrong) and HA won't find it. Clone into `bluetooth-radar-src` and link/copy as
> shown.

If `git` is missing, `apk add git` usually works in the add-on. If symlinks
aren't picked up in your setup, **copy instead**:

```bash
cp -r bluetooth-radar-src/custom_components/bluetooth_radar /config/custom_components/
cp bluetooth-radar-src/www/bluetooth-radar-card.js /config/www/
```

**Updating later:** `cd /config/bluetooth-radar-src && git pull`, then restart HA
(for integration changes) or hard-refresh the browser (for card-only changes).

#### Method B — Manual copy / rsync

Copy the same two paths from this repo into `<config>/custom_components/` and
`<config>/www/`. See [Deploying to your NAS](#deploying-to-your-nas) for ready
made `rsync` commands.

### Step 2 — Set up the integration

1. **Restart Home Assistant** (Settings → System → ⋮ → **Restart**) so it picks
   up the new `custom_components` folder.
2. Go to **Settings → Devices & Services → Add Integration**, search for
   **Bluetooth Radar**, and add it. You'll be asked for:

   | Option | Default | Meaning |
   |--------|---------|---------|
   | Measured power | `-59` dBm | RSSI at 1 m from a reference device. Lower (more negative) ⇒ devices read as further away. |
   | Path-loss exponent | `2.5` | `2.0` = open space, `3–4` = lots of walls. Higher ⇒ distance grows faster. |
   | Outer range | `15` m | The outermost radar ring. |
   | Drop after | `60` s | Remove a device not heard from in this long. |

   These can be retuned anytime via the integration's **Configure** button — no
   restart needed.

### Step 3 — Register the card as a Lovelace resource

The card's JS file has to be registered once before any dashboard can use it.

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

### Step 4 — Add the card to a dashboard (for testing)

1. Open the dashboard where you want the radar.
2. Click the ✏️ **pencil (Edit dashboard)** in the top-right → **+ Add Card**.
3. Scroll to the bottom and choose **Manual** (or search for
   "Bluetooth Radar Card" in the picker).
4. Paste this and click **Save**:

   ```yaml
   type: custom:bluetooth-radar-card
   title: Bluetooth Radar
   # optional overrides:
   # max_distance: 15      # outer ring in metres (defaults to integration setting)
   # sweep_seconds: 4      # seconds per full sweep revolution
   # show_labels: true     # device name + distance next to each blip
   # name_filter: "iphone" # only show devices whose name contains this
   ```

You should see a green radar scope with a rotating sweep. Within a few seconds,
blips appear as your proxy reports BLE devices. The header shows a live device
count.

**Quick troubleshooting:**

| Symptom | Likely cause / fix |
|---------|--------------------|
| `Custom element doesn't exist: bluetooth-radar-card` | Resource not registered (Step 3) or browser cached — hard-refresh, or add `?v=2` to the resource URL. |
| Card shows "integration not found" | Integration not added/loaded (Step 2) — check it appears under Devices & Services. |
| Sweep spins but no blips ever appear | No BLE devices in range, or your Bluetooth proxy isn't feeding HA. Check **Settings → Devices & Services → Bluetooth** sees advertisements. |
| Blips all sit on the outer ring | Devices report no RSSI, or `max_distance` is too small — raise it, or tune **measured power**. |

> **HACS:** this repo also works as a custom HACS repository (integration +
> Lovelace plugin). Add it as a custom repository if you prefer managed
> updates — HACS installs the integration and registers the card resource for
> you (you still restart HA after integration updates).

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

## Flight Radar (same scope, real bearings)

The same card can also plot **aircraft around a location** — and unlike the
Bluetooth radar, this one is *honest in both axes*: aircraft broadcast their GPS
position, so **distance and bearing are both real**. North is up, blips are
little triangles pointing along each aircraft's track.

It's a second integration (`flight_radar`) that shares the same card file, so
you can run **both radars at once**.

### Data sources

| Source | Hardware | Notes |
|--------|----------|-------|
| **OpenSky Network** (default) | none | Free cloud API. Works anonymously but is heavily rate-limited; add free **OpenSky OAuth2 client credentials** (client ID + secret) for usable limits. Keep the update interval ≥ ~10 s. |
| **Local ADS-B receiver** | RTL-SDR | Point it at your `aircraft.json` (dump1090 / tar1090 / readsb / PiAware), e.g. `http://<host>/tar1090/data/aircraft.json`. No rate limits, fully local, fastest. |

### Setup

1. The files are already installed (same repo, `custom_components/flight_radar/`
   ships alongside `bluetooth_radar/`). After the usual restart, add
   **Settings → Devices & Services → Add Integration → Flight Radar**.
2. Configure:

   | Option | Default | Meaning |
   |--------|---------|---------|
   | Centre latitude / longitude | your HA **Home** location | Where the radar is centred. Change to watch any spot. |
   | Radar range | `100` km | Outer ring distance. |
   | Update interval | `15` s | Poll cadence. Lower only with a local receiver. |
   | Data source | OpenSky | `OpenSky Network` or `Local ADS-B receiver`. |
   | OpenSky client ID / secret | empty | Optional; strongly recommended for OpenSky. |
   | Local ADS-B URL | empty | Required if source = local. |

3. Add the card (the card resource is already registered from the Bluetooth
   setup — no extra resource needed):

   ```yaml
   type: custom:flight-radar-card
   title: Flight Radar
   # optional:
   # max_distance: 100     # outer ring in km (defaults to integration range)
   # sweep_seconds: 4
   # show_labels: true
   # name_filter: "RYR"    # e.g. only Ryanair callsigns
   ```

> The `bluetooth-radar-card` and `flight-radar-card` are the **same code** with
> different defaults. You can also write `type: custom:bluetooth-radar-card`
> with `mode: flights` (or vice-versa) — the `mode:` option wins.

## Tuning tips

- Devices appearing too close/too far? Adjust **measured power** first, then
  **path-loss exponent**.
- A crowded scope? Use `name_filter`, or lower **Drop after** so absent devices
  vanish quicker.
- Unknown-distance devices (no RSSI) are parked on the outer ring.

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
