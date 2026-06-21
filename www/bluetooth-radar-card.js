/*
 * Radar Card  (bluetooth-radar-card / flight-radar-card)
 * A retro CRT radar display for Home Assistant.
 *
 *   mode: "bluetooth"  -> BLE devices heard by your Bluetooth proxies.
 *                         radius = distance from RSSI (real);
 *                         angle  = stable synthetic bearing per device.
 *   mode: "flights"    -> aircraft around a chosen location.
 *                         radius = real distance, angle = real bearing,
 *                         blips drawn as triangles pointing along heading.
 *
 * One resource file registers BOTH custom elements:
 *   type: custom:bluetooth-radar-card     (mode defaults to bluetooth)
 *   type: custom:flight-radar-card        (mode defaults to flights)
 * You can also force a mode:  mode: flights
 *
 * Common config:
 *   title: "..."           # header text
 *   max_distance: 100      # outer ring (m for bluetooth, km for flights)
 *   sweep_seconds: 4       # seconds per full sweep revolution
 *   show_labels: true      # labels next to blips
 *   name_filter: "..."     # only show items whose name contains this
 */

const SWEEP_TRAIL = Math.PI / 2.2;
const TAU = Math.PI * 2;

const SUBSCRIBE_TYPE = {
  bluetooth: "bluetooth_radar/subscribe",
  flights: "flight_radar/subscribe",
};
const DEFAULT_UNIT = { bluetooth: "m", flights: "km" };
const DEFAULT_TITLE = { bluetooth: "Bluetooth Radar", flights: "Flight Radar" };
const NOUN = { bluetooth: "device", flights: "aircraft" };

// Compass bearing (0 = north, clockwise) -> canvas angle (0 = east/right,
// clockwise because canvas y points down). North must appear at the top.
function compassToCanvas(deg) {
  return ((deg - 90) * Math.PI) / 180;
}

class RadarCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = [];
    this._maxDistance = null;
    this._unit = null;
    this._blips = new Map();
    this._sweepAngle = 0;
    this._lastFrame = 0;
    this._unsub = null;
    this._raf = null;
    this._selected = null; // address of the blip whose details are open
    this._routeCache = new Map();
  }

  // Subclasses override to set the default mode.
  static get RADAR_MODE() {
    return "bluetooth";
  }

  setConfig(config) {
    this._config = config || {};
    this._mode = this._config.mode || this.constructor.RADAR_MODE;
    if (!SUBSCRIBE_TYPE[this._mode]) this._mode = "bluetooth";
    this._maxDistance = Number(this._config.max_distance) || null;
    this._size = Number(this._config.size) || null; // px; caps + centres the scope
    this._sweepSeconds = Number(this._config.sweep_seconds) || 4;
    this._showLabels = this._config.show_labels !== false;
    this._nameFilter = (this._config.name_filter || "").toLowerCase();
    this._unit = DEFAULT_UNIT[this._mode];
    // Resubscribe if the mode changed at runtime.
    if (this._unsub) {
      Promise.resolve(this._unsub).then((fn) => fn && fn());
      this._unsub = null;
    }
    this._render();
    if (this._hass) this._subscribe();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && !this._unsub) this._subscribe();
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    if (this._hass && !this._unsub) this._subscribe();
    this._startLoop();
  }

  disconnectedCallback() {
    this._stopLoop();
    if (this._unsub) {
      Promise.resolve(this._unsub).then((fn) => fn && fn());
      this._unsub = null;
    }
  }

  async _subscribe() {
    if (!this._hass || !this._hass.connection || !this._mode) return;
    try {
      this._unsub = await this._hass.connection.subscribeMessage(
        (msg) => this._onSnapshot(msg),
        { type: SUBSCRIBE_TYPE[this._mode] }
      );
    } catch (err) {
      this._setStatus(
        `${this._mode === "flights" ? "Flight" : "Bluetooth"} Radar integration not found — add it under Settings → Devices & Services.`
      );
    }
  }

  _onSnapshot(msg) {
    this._devices = (msg.devices || []).filter((d) =>
      this._nameFilter
        ? (d.name || "").toLowerCase().includes(this._nameFilter)
        : true
    );
    const cfg = msg.config || {};
    if (cfg.unit) this._unit = cfg.unit;
    if (cfg.max_distance && !this._config.max_distance) {
      this._maxDistance = cfg.max_distance;
    }
    const noun = NOUN[this._mode];
    const n = this._devices.length;
    this._setStatus(`${n} ${noun}${n === 1 ? "" : "s"} in range`);

    // Keep an open details panel in sync; close it if the blip is gone.
    if (this._selected) {
      const dev = this._devices.find((d) => d.address === this._selected);
      if (!dev) this._hideDetails();
      else this._renderDetails(dev);
    }
  }

  _setStatus(text) {
    if (this._statusEl) this._statusEl.textContent = text;
  }

  _startLoop() {
    if (this._raf) return;
    this._lastFrame = performance.now();
    const loop = (now) => {
      const dt = (now - this._lastFrame) / 1000;
      this._lastFrame = now;
      this._update(dt);
      this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _update(dt) {
    const speed = TAU / this._sweepSeconds;
    const prev = this._sweepAngle;
    this._sweepAngle = (this._sweepAngle + speed * dt) % TAU;
    const ease = Math.min(dt * 3, 1);
    const maxD = this._maxDistance || 1;

    const seen = new Set();
    for (const dev of this._devices) {
      seen.add(dev.address);
      const targetAngle = compassToCanvas(dev.angle || 0);
      const radius = dev.distance == null ? 1 : Math.min(dev.distance / maxD, 1);

      let blip = this._blips.get(dev.address);
      if (!blip) {
        blip = { brightness: 0.4, angle: targetAngle, radius };
        this._blips.set(dev.address, blip);
      }
      blip.radius += (radius - blip.radius) * ease;
      // Ease angle along the shortest path (handles 359° -> 1° wrap).
      let da = targetAngle - blip.angle;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      blip.angle += da * ease;
      blip.dev = dev;

      const a = ((blip.angle % TAU) + TAU) % TAU;
      const passed =
        prev <= this._sweepAngle
          ? a > prev && a <= this._sweepAngle
          : a > prev || a <= this._sweepAngle;
      if (passed) blip.brightness = 1;
    }

    for (const [addr, blip] of this._blips) {
      blip.brightness -= dt * 0.35;
      if (!seen.has(addr) && blip.brightness <= 0) {
        this._blips.delete(addr);
      } else if (blip.brightness < 0.15) {
        blip.brightness = 0.15;
      }
    }
  }

  _draw() {
    const canvas = this._canvas;
    if (!canvas) return;
    const ctx = this._ctx;
    const dpr = window.devicePixelRatio || 1;
    const size = canvas.clientWidth;
    if (canvas.width !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
    }
    const W = canvas.width;
    const cx = W / 2;
    const cy = W / 2;
    const R = W / 2 - 12 * dpr;
    const green = "0, 255, 102";
    const isFlights = this._mode === "flights";

    ctx.clearRect(0, 0, W, W);

    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    bg.addColorStop(0, "rgba(0, 40, 16, 0.95)");
    bg.addColorStop(1, "rgba(0, 8, 4, 1)");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.clip();

    // Range rings + distance labels.
    const rings = 4;
    const unit = this._unit || "";
    const maxD = this._maxDistance || 0;
    ctx.lineWidth = 1 * dpr;
    ctx.font = `${10 * dpr}px monospace`;
    ctx.fillStyle = `rgba(${green}, 0.55)`;
    for (let i = 1; i <= rings; i++) {
      const rr = (R * i) / rings;
      ctx.strokeStyle = `rgba(${green}, 0.22)`;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, TAU);
      ctx.stroke();
      const label = `${((maxD * i) / rings).toFixed(maxD <= 5 ? 1 : 0)}${unit}`;
      ctx.fillText(label, cx + 3 * dpr, cy - rr + 12 * dpr);
    }

    // Radial graticule.
    ctx.strokeStyle = `rgba(${green}, 0.18)`;
    for (let a = 0; a < TAU; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }

    // Compass labels (only meaningful for flights, where bearing is real).
    if (isFlights) {
      ctx.fillStyle = `rgba(${green}, 0.7)`;
      ctx.font = `bold ${12 * dpr}px monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const compass = [
        ["N", 0],
        ["E", 90],
        ["S", 180],
        ["W", 270],
      ];
      for (const [letter, brg] of compass) {
        const ang = compassToCanvas(brg);
        ctx.fillText(
          letter,
          cx + Math.cos(ang) * (R - 10 * dpr),
          cy + Math.sin(ang) * (R - 10 * dpr)
        );
      }
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }

    // Sweep with fading trail.
    ctx.save();
    ctx.translate(cx, cy);
    for (let i = 0; i < 24; i++) {
      const frac = i / 24;
      const a0 = this._sweepAngle - frac * SWEEP_TRAIL;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R, a0 - 0.03, a0 + 0.03);
      ctx.closePath();
      ctx.fillStyle = `rgba(${green}, ${0.25 * (1 - frac)})`;
      ctx.fill();
    }
    ctx.strokeStyle = `rgba(${green}, 0.9)`;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(this._sweepAngle) * R, Math.sin(this._sweepAngle) * R);
    ctx.stroke();
    ctx.restore();

    // Blips.
    for (const blip of this._blips.values()) {
      if (!blip.dev) continue;
      const r = blip.radius * R;
      const bx = cx + Math.cos(blip.angle) * r;
      const by = cy + Math.sin(blip.angle) * r;
      const b = Math.max(0, Math.min(1, blip.brightness));

      const glow = ctx.createRadialGradient(bx, by, 0, bx, by, 9 * dpr);
      glow.addColorStop(0, `rgba(${green}, ${0.9 * b})`);
      glow.addColorStop(1, `rgba(${green}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(bx, by, 9 * dpr, 0, TAU);
      ctx.fill();

      if (blip.dev.address === this._selected) {
        ctx.strokeStyle = `rgba(255, 255, 255, 0.9)`;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.arc(bx, by, 11 * dpr, 0, TAU);
        ctx.stroke();
      }

      if (isFlights && blip.dev.heading != null) {
        // Triangle pointing along the aircraft's track.
        const h = compassToCanvas(blip.dev.heading);
        const s = 5 * dpr;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(h);
        ctx.fillStyle = `rgba(190, 255, 210, ${b})`;
        ctx.beginPath();
        ctx.moveTo(s * 1.6, 0);
        ctx.lineTo(-s, s);
        ctx.lineTo(-s, -s);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = `rgba(180, 255, 200, ${b})`;
        ctx.beginPath();
        ctx.arc(bx, by, 2.5 * dpr, 0, TAU);
        ctx.fill();
      }

      if (this._showLabels && b > 0.25) {
        ctx.fillStyle = `rgba(${green}, ${b})`;
        ctx.font = `${11 * dpr}px monospace`;
        ctx.fillText(this._shortName(blip.dev), bx + 7 * dpr, by - 4 * dpr);
        const subs = this._subLabels(blip.dev, unit);
        ctx.fillStyle = `rgba(${green}, ${0.6 * b})`;
        ctx.font = `${9 * dpr}px monospace`;
        let yy = by + 8 * dpr;
        for (const line of subs) {
          ctx.fillText(line, bx + 7 * dpr, yy);
          yy += 10 * dpr;
        }
      }
    }

    // Scanlines.
    ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
    for (let y = 0; y < W; y += 3 * dpr) {
      ctx.fillRect(0, y, W, 1 * dpr);
    }
    ctx.restore();

    // Bezel + centre.
    ctx.strokeStyle = `rgba(${green}, 0.5)`;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = `rgba(${green}, 0.9)`;
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * dpr, 0, TAU);
    ctx.fill();
  }

  _subLabels(dev, unit) {
    if (this._mode === "flights") {
      const parts = [];
      if (dev.altitude != null) parts.push(`${dev.altitude}ft`);
      if (dev.distance != null) parts.push(`${dev.distance}${unit}`);
      return parts.length ? [parts.join("  ")] : [];
    }
    // Bluetooth: manufacturer under the name/MAC, then distance.
    const lines = [];
    const mfr = this._shortManufacturer(dev.manufacturer);
    if (mfr) lines.push(mfr);
    if (dev.distance != null) lines.push(`${dev.distance}${unit}`);
    return lines;
  }

  _shortManufacturer(m) {
    if (!m) return null;
    // Strip the trailing "(0x004C)" so the scope label stays compact.
    return m.replace(/\s*\(0x[0-9A-Fa-f]+\)\s*$/, "");
  }

  _shortName(dev) {
    const n = dev.name || dev.address || "?";
    return n.length > 18 ? n.slice(0, 17) + "…" : n;
  }

  // --- click-to-inspect ---------------------------------------------------

  _onCanvasClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const size = this._canvas.clientWidth;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 12;

    let best = null;
    let bestDist = 16; // px hit radius
    for (const blip of this._blips.values()) {
      if (!blip.dev) continue;
      const r = blip.radius * R;
      const bx = cx + Math.cos(blip.angle) * r;
      const by = cy + Math.sin(blip.angle) * r;
      const d = Math.hypot(x - bx, y - by);
      if (d < bestDist) {
        bestDist = d;
        best = blip.dev;
      }
    }
    if (best) {
      this._selected = best.address;
      this._renderDetails(best);
    } else {
      this._hideDetails();
    }
  }

  _hideDetails() {
    this._selected = null;
    if (this._detailsEl) {
      this._detailsEl.hidden = true;
      this._detailsEl.innerHTML = "";
    }
  }

  _detailRows(dev) {
    const unit = this._unit || "";
    const rows = [];
    const add = (label, value) => {
      if (value !== null && value !== undefined && value !== "")
        rows.push([label, value]);
    };
    if (this._mode === "flights") {
      add("Callsign", dev.name);
      add("ICAO24", dev.icao24 || dev.address);
      add("Country", dev.country);
      add("Altitude", dev.altitude != null ? `${dev.altitude} ft` : null);
      add("Speed", dev.speed != null ? `${dev.speed} kt` : null);
      add("Heading", dev.heading != null ? `${dev.heading}°` : null);
      if (dev.vertical_rate != null && dev.vertical_rate !== 0) {
        const arrow = dev.vertical_rate > 0 ? "↑" : "↓";
        add("Vert. rate", `${arrow} ${Math.abs(dev.vertical_rate)} ft/min`);
      }
      add("Squawk", dev.squawk);
      add("Distance", dev.distance != null ? `${dev.distance} ${unit}` : null);
      add("Bearing", dev.angle != null ? `${Math.round(dev.angle)}°` : null);
      if (dev.lat != null && dev.lon != null)
        add("Position", `${dev.lat}, ${dev.lon}`);
    } else {
      add("Name", dev.name);
      add("Address", dev.address);
      add("Addr type", dev.address_kind);
      add("RSSI", dev.rssi != null ? `${dev.rssi} dBm` : null);
      add("Distance", dev.distance != null ? `${dev.distance} ${unit}` : null);
      add("Manufacturer", dev.manufacturer);
      if (Array.isArray(dev.company_ids) && dev.company_ids.length)
        add("Company IDs", dev.company_ids.join(", "));
      add("TX power", dev.tx_power != null ? `${dev.tx_power} dBm` : null);
      add(
        "Connectable",
        dev.connectable === true ? "yes" : dev.connectable === false ? "no" : null
      );
      add("Closest proxy", dev.source);
      if (dev.proxy_count)
        add(
          "Heard by",
          `${dev.proxy_count} prox${dev.proxy_count === 1 ? "y" : "ies"}`
        );
      if (Array.isArray(dev.proxies) && dev.proxies.length > 1)
        add(
          "All proxies",
          dev.proxies.map((p) => `${p.name} ${p.rssi}dBm`).join(", ")
        );
      const svc =
        dev.service_names && dev.service_names.length
          ? dev.service_names
          : dev.service_uuids;
      if (Array.isArray(svc) && svc.length) add("Services", svc.join(", "));
      if (Array.isArray(dev.service_data_uuids) && dev.service_data_uuids.length)
        add("Service data", dev.service_data_uuids.join(", "));
      if (dev.ibeacon) {
        add("iBeacon UUID", dev.ibeacon.uuid);
        add("iBeacon", `major ${dev.ibeacon.major} / minor ${dev.ibeacon.minor}`);
        add("Beacon power", `${dev.ibeacon.power} dBm @1m`);
      }
      add("Eddystone URL", dev.eddystone_url);
      add("Last seen", dev.age != null ? `${dev.age}s ago` : null);
    }
    return rows;
  }

  _renderDetails(dev) {
    if (!this._detailsEl) return;
    const rows = this._detailRows(dev)
      .map(
        ([k, v]) =>
          `<div class="k">${k}</div><div class="v">${this._esc(v)}</div>`
      )
      .join("");

    let extra = "";
    if (this._mode === "flights") {
      const hex = (dev.icao24 || dev.address || "").toLowerCase();
      const cs = (dev.name || "").trim();
      extra = `
        <div class="k">Route</div><div class="v" id="route">…</div>
        <div class="links">
          ${hex ? `<a href="https://globe.adsbexchange.com/?icao=${hex}" target="_blank" rel="noopener">track on ADS-B Exchange ↗</a>` : ""}
          ${cs ? `<a href="https://www.flightradar24.com/${encodeURIComponent(cs)}" target="_blank" rel="noopener">FlightRadar24 ↗</a>` : ""}
        </div>`;
    }

    this._detailsEl.innerHTML = `
      <button class="close" title="Close">✕</button>
      <div class="title">${this._esc(this._shortName(dev))}</div>
      <div class="grid">${rows}${extra}</div>
    `;
    this._detailsEl.hidden = false;
    this._detailsEl
      .querySelector(".close")
      .addEventListener("click", () => this._hideDetails());

    if (this._mode === "flights") this._fetchRoute(dev);
  }

  _fetchRoute(dev) {
    const cs = (dev.name || "").trim();
    const setLine = (text) => {
      if (this._selected !== dev.address || !this._detailsEl) return;
      const el = this._detailsEl.querySelector("#route");
      if (el) el.textContent = text;
    };
    if (!cs) {
      setLine("n/a");
      return;
    }
    if (this._routeCache.has(cs)) {
      setLine(this._routeText(this._routeCache.get(cs)));
      return;
    }
    if (!this._hass || !this._hass.connection) {
      setLine("unavailable");
      return;
    }
    this._hass.connection
      .sendMessagePromise({ type: "flight_radar/route", callsign: cs })
      .then((r) => {
        this._routeCache.set(cs, r || {});
        setLine(this._routeText(r || {}));
      })
      .catch(() => setLine("unavailable"));
  }

  _routeText(r) {
    if (r && r.departure && r.arrival) return `${r.departure} → ${r.arrival}`;
    return "unavailable (try the links)";
  }

  _esc(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  _render() {
    const title =
      this._config.title || DEFAULT_TITLE[this._mode] || "Radar";
    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          padding: 12px;
          background: #050d08;
          border: 1px solid rgba(0, 255, 102, 0.25);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          color: #00ff66;
          font-family: monospace;
          letter-spacing: 1px;
          margin-bottom: 8px;
        }
        .header .title { font-size: 15px; text-transform: uppercase; }
        .header .status { font-size: 11px; opacity: 0.8; }
        .scope {
          position: relative;
          width: 100%;
          aspect-ratio: 1 / 1;
          ${this._size ? `max-width: ${this._size}px;` : ""}
          margin: 0 auto;
        }
        canvas {
          width: 100%;
          height: 100%;
          display: block;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 0 24px rgba(0, 255, 102, 0.25) inset,
                      0 0 12px rgba(0, 255, 102, 0.15);
        }
        .details {
          position: absolute;
          left: 8px;
          bottom: 8px;
          max-width: min(70%, 320px);
          background: rgba(2, 18, 8, 0.92);
          border: 1px solid rgba(0, 255, 102, 0.5);
          border-radius: 6px;
          padding: 10px 12px;
          color: #00ff66;
          font-family: monospace;
          font-size: 12px;
          box-shadow: 0 0 16px rgba(0, 255, 102, 0.25);
        }
        .details .title {
          font-size: 13px;
          font-weight: 700;
          margin-bottom: 6px;
          padding-right: 16px;
        }
        .details .grid {
          display: grid;
          grid-template-columns: auto 1fr;
          gap: 2px 10px;
        }
        .details .k { opacity: 0.65; }
        .details .v { text-align: right; word-break: break-word; }
        .details .links {
          grid-column: 1 / -1;
          margin-top: 6px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .details a { color: #6effa6; }
        .details .close {
          position: absolute;
          top: 4px;
          right: 6px;
          background: none;
          border: none;
          color: #00ff66;
          font-family: monospace;
          font-size: 14px;
          cursor: pointer;
          line-height: 1;
        }
      </style>
      <ha-card>
        <div class="header">
          <span class="title">${title}</span>
          <span class="status" id="status">connecting…</span>
        </div>
        <div class="scope">
          <canvas id="scope"></canvas>
          <div class="details" id="details" hidden></div>
        </div>
      </ha-card>
    `;
    this._canvas = this.shadowRoot.getElementById("scope");
    this._ctx = this._canvas.getContext("2d");
    this._statusEl = this.shadowRoot.getElementById("status");
    this._detailsEl = this.shadowRoot.getElementById("details");
    this._canvas.addEventListener("click", (e) => this._onCanvasClick(e));
    this._selected = null;
  }
}

class BluetoothRadarCard extends RadarCard {
  static get RADAR_MODE() {
    return "bluetooth";
  }
}

class FlightRadarCard extends RadarCard {
  static get RADAR_MODE() {
    return "flights";
  }
}

customElements.define("bluetooth-radar-card", BluetoothRadarCard);
customElements.define("flight-radar-card", FlightRadarCard);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "bluetooth-radar-card",
    name: "Bluetooth Radar Card",
    description: "Retro CRT radar of BLE devices heard by your Bluetooth proxies.",
    preview: false,
  },
  {
    type: "flight-radar-card",
    name: "Flight Radar Card",
    description: "Retro CRT radar of aircraft around a chosen location.",
    preview: false,
  }
);

console.info(
  "%c RADAR-CARD %c v1.2.0  (bluetooth + flights, click-to-inspect) ",
  "color: #050d08; background: #00ff66; font-weight: 700;",
  "color: #00ff66; background: #050d08;"
);
