/*
 * Bluetooth Radar Card
 * A retro CRT flight-radar display for Home Assistant that plots BLE
 * devices heard by your Bluetooth proxies.
 *
 *   radius -> estimated distance from RSSI (real)
 *   angle  -> stable synthetic bearing per device (decorative; a single
 *             proxy cannot measure direction)
 *
 * Configuration (Lovelace):
 *   type: custom:bluetooth-radar-card
 *   title: Bluetooth Radar      # optional
 *   max_distance: 15            # optional, overrides integration range (m)
 *   sweep_seconds: 4            # optional, seconds per full revolution
 *   show_labels: true           # optional
 *   name_filter: ""             # optional, only show names matching substring
 */

const SWEEP_TRAIL = Math.PI / 2.2; // angular length of the fading sweep trail

class BluetoothRadarCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._devices = [];
    this._maxDistance = 15;
    this._blips = new Map(); // address -> { brightness, angle, radius, ... }
    this._sweepAngle = 0;
    this._lastFrame = 0;
    this._unsub = null;
    this._raf = null;
  }

  setConfig(config) {
    this._config = config || {};
    this._maxDistance = Number(config.max_distance) || this._maxDistance;
    this._sweepSeconds = Number(config.sweep_seconds) || 4;
    this._showLabels = config.show_labels !== false;
    this._nameFilter = (config.name_filter || "").toLowerCase();
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && !this._unsub) {
      this._subscribe();
    }
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
    if (!this._hass || !this._hass.connection) return;
    try {
      this._unsub = await this._hass.connection.subscribeMessage(
        (msg) => this._onSnapshot(msg),
        { type: "bluetooth_radar/subscribe" }
      );
    } catch (err) {
      this._setStatus(
        "Bluetooth Radar integration not found. Add it under Settings → Devices & Services."
      );
    }
  }

  _onSnapshot(msg) {
    this._devices = (msg.devices || []).filter((d) =>
      this._nameFilter ? (d.name || "").toLowerCase().includes(this._nameFilter) : true
    );
    if (msg.config && msg.config.max_distance && !this._config.max_distance) {
      this._maxDistance = msg.config.max_distance;
    }
    this._setStatus(
      `${this._devices.length} device${this._devices.length === 1 ? "" : "s"} in range`
    );
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
    // Advance the sweep clockwise.
    const speed = (Math.PI * 2) / this._sweepSeconds;
    const prev = this._sweepAngle;
    this._sweepAngle = (this._sweepAngle + speed * dt) % (Math.PI * 2);

    // Reconcile blips with the latest device list.
    const seen = new Set();
    for (const dev of this._devices) {
      seen.add(dev.address);
      const angle = ((dev.angle || 0) * Math.PI) / 180;
      let radius;
      if (dev.distance == null) {
        radius = 1; // unknown distance -> park at the edge
      } else {
        radius = Math.min(dev.distance / this._maxDistance, 1);
      }
      let blip = this._blips.get(dev.address);
      if (!blip) {
        blip = { brightness: 0.4, angle, radius };
        this._blips.set(dev.address, blip);
      }
      // Smoothly ease toward the new radius so blips glide, not jump.
      blip.radius += (radius - blip.radius) * Math.min(dt * 3, 1);
      blip.angle = angle;
      blip.dev = dev;

      // Re-light a blip when the sweep passes its bearing (classic radar).
      const passed =
        prev <= this._sweepAngle
          ? angle > prev && angle <= this._sweepAngle
          : angle > prev || angle <= this._sweepAngle;
      if (passed) blip.brightness = 1;
    }

    // Fade and retire blips.
    for (const [addr, blip] of this._blips) {
      blip.brightness -= dt * 0.35;
      if (!seen.has(addr) && blip.brightness <= 0) {
        this._blips.delete(addr);
      } else if (blip.brightness < 0.15) {
        blip.brightness = 0.15; // keep a faint persistent dot while present
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

    ctx.clearRect(0, 0, W, W);

    // Scope background + vignette.
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    bg.addColorStop(0, "rgba(0, 40, 16, 0.95)");
    bg.addColorStop(1, "rgba(0, 8, 4, 1)");
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Range rings + distance labels.
    const rings = 4;
    ctx.lineWidth = 1 * dpr;
    ctx.font = `${10 * dpr}px monospace`;
    ctx.fillStyle = `rgba(${green}, 0.55)`;
    for (let i = 1; i <= rings; i++) {
      const rr = (R * i) / rings;
      ctx.strokeStyle = `rgba(${green}, 0.22)`;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
      const meters = ((this._maxDistance * i) / rings).toFixed(0);
      ctx.fillText(`${meters}m`, cx + 3 * dpr, cy - rr + 12 * dpr);
    }

    // Cross hairs + diagonals.
    ctx.strokeStyle = `rgba(${green}, 0.18)`;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }

    // Sweep wedge with fading trail.
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
    // Leading edge line.
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
      ctx.arc(bx, by, 9 * dpr, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = `rgba(180, 255, 200, ${b})`;
      ctx.beginPath();
      ctx.arc(bx, by, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();

      if (this._showLabels && b > 0.25) {
        const label = this._shortName(blip.dev);
        ctx.fillStyle = `rgba(${green}, ${b})`;
        ctx.font = `${11 * dpr}px monospace`;
        ctx.fillText(label, bx + 6 * dpr, by - 4 * dpr);
        if (blip.dev.distance != null) {
          ctx.fillStyle = `rgba(${green}, ${0.6 * b})`;
          ctx.font = `${9 * dpr}px monospace`;
          ctx.fillText(`${blip.dev.distance}m`, bx + 6 * dpr, by + 8 * dpr);
        }
      }
    }

    // Scanline overlay for that CRT feel.
    ctx.fillStyle = "rgba(0, 0, 0, 0.10)";
    for (let y = 0; y < W; y += 3 * dpr) {
      ctx.fillRect(0, y, W, 1 * dpr);
    }

    ctx.restore();

    // Outer bezel ring.
    ctx.strokeStyle = `rgba(${green}, 0.5)`;
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Center dot.
    ctx.fillStyle = `rgba(${green}, 0.9)`;
    ctx.beginPath();
    ctx.arc(cx, cy, 3 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }

  _shortName(dev) {
    const n = dev.name || dev.address || "?";
    if (n.length > 18) return n.slice(0, 17) + "…";
    return n;
  }

  _render() {
    const title = this._config.title || "Bluetooth Radar";
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
        }
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
        <div class="scope">
          <canvas id="scope"></canvas>
        </div>
      </ha-card>
    `;
    this._canvas = this.shadowRoot.getElementById("scope");
    this._ctx = this._canvas.getContext("2d");
    this._statusEl = this.shadowRoot.getElementById("status");
  }
}

customElements.define("bluetooth-radar-card", BluetoothRadarCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "bluetooth-radar-card",
  name: "Bluetooth Radar Card",
  description: "A retro CRT radar showing BLE devices heard by your Bluetooth proxies.",
  preview: false,
});

console.info(
  "%c BLUETOOTH-RADAR-CARD %c v1.0.0 ",
  "color: #050d08; background: #00ff66; font-weight: 700;",
  "color: #00ff66; background: #050d08;"
);
