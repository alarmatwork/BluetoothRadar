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
        const sub = this._subLabel(blip.dev, unit);
        if (sub) {
          ctx.fillStyle = `rgba(${green}, ${0.6 * b})`;
          ctx.font = `${9 * dpr}px monospace`;
          ctx.fillText(sub, bx + 7 * dpr, by + 8 * dpr);
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

  _subLabel(dev, unit) {
    const parts = [];
    if (dev.altitude != null) parts.push(`${dev.altitude}ft`);
    if (dev.distance != null) parts.push(`${dev.distance}${unit}`);
    return parts.join("  ");
  }

  _shortName(dev) {
    const n = dev.name || dev.address || "?";
    return n.length > 18 ? n.slice(0, 17) + "…" : n;
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
        .scope { position: relative; width: 100%; aspect-ratio: 1 / 1; }
        canvas {
          width: 100%;
          height: 100%;
          display: block;
          border-radius: 50%;
          box-shadow: 0 0 24px rgba(0, 255, 102, 0.25) inset,
                      0 0 12px rgba(0, 255, 102, 0.15);
        }
      </style>
      <ha-card>
        <div class="header">
          <span class="title">${title}</span>
          <span class="status" id="status">connecting…</span>
        </div>
        <div class="scope"><canvas id="scope"></canvas></div>
      </ha-card>
    `;
    this._canvas = this.shadowRoot.getElementById("scope");
    this._ctx = this._canvas.getContext("2d");
    this._statusEl = this.shadowRoot.getElementById("status");
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
  "%c RADAR-CARD %c v1.1.0  (bluetooth + flights) ",
  "color: #050d08; background: #00ff66; font-weight: 700;",
  "color: #00ff66; background: #050d08;"
);
