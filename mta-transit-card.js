// MTA Transit Card for Home Assistant Lovelace
// Place this file in your HA config's /config/www/ directory,
// then add to Lovelace resources: /local/mta-transit-card.js

const MTA_COLORS = {
  "1":   { bg: "#EE352E", text: "#fff" },
  "2":   { bg: "#EE352E", text: "#fff" },
  "3":   { bg: "#EE352E", text: "#fff" },
  "4":   { bg: "#00933C", text: "#fff" },
  "5":   { bg: "#00933C", text: "#fff" },
  "6":   { bg: "#00933C", text: "#fff" },
  "7":   { bg: "#B933AD", text: "#fff" },
  "A":   { bg: "#0039A6", text: "#fff" },
  "C":   { bg: "#0039A6", text: "#fff" },
  "E":   { bg: "#0039A6", text: "#fff" },
  "B":   { bg: "#FF6319", text: "#fff" },
  "D":   { bg: "#FF6319", text: "#fff" },
  "F":   { bg: "#FF6319", text: "#fff" },
  "M":   { bg: "#FF6319", text: "#fff" },
  "G":   { bg: "#6CBE45", text: "#fff" },
  "J":   { bg: "#996633", text: "#fff" },
  "Z":   { bg: "#996633", text: "#fff" },
  "L":   { bg: "#A7A9AC", text: "#fff" },
  "N":   { bg: "#FCCC0A", text: "#000" },
  "Q":   { bg: "#FCCC0A", text: "#000" },
  "R":   { bg: "#FCCC0A", text: "#000" },
  "W":   { bg: "#FCCC0A", text: "#000" },
  "S":   { bg: "#808183", text: "#fff" },
  "SIR": { bg: "#0039A6", text: "#fff" },
};

const BUS_COLORS = { bg: "#1D4E89", text: "#fff" };

function lineStyle(routeId) {
  return MTA_COLORS[routeId] ?? BUS_COLORS;
}

function isBullet(routeId) {
  return routeId.length <= 2;
}

function formatMinutes(arrivalEpoch, nowEpoch) {
  const mins = Math.floor((arrivalEpoch - nowEpoch) / 60);
  if (mins < 1) return `<span class="arr">ARR</span>`;
  return `${mins}<span class="unit">m</span>`;
}

const STYLES = `
  :host { display: block; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; }

  .board {
    background: #0d0d0d;
    border-radius: 14px;
    padding: 14px 16px;
    color: #fff;
  }

  .stop + .stop {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid #222;
  }

  .stop-header {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
  }

  .stop-icon { font-size: 13px; }

  .stop-name {
    font-size: 11px;
    font-weight: 700;
    color: #777;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .route-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    column-gap: 10px;
    padding: 4px 0;
    min-height: 36px;
  }

  /* Circle bullet for single-char routes (1-9, A-Z) */
  .bullet {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 800;
    font-size: 15px;
    flex-shrink: 0;
    letter-spacing: -0.02em;
  }

  /* Pill for multi-char bus routes like M15-SBS */
  .pill {
    height: 26px;
    padding: 0 8px;
    border-radius: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 11px;
    flex-shrink: 0;
    white-space: nowrap;
    letter-spacing: 0.02em;
  }

  .headsign {
    font-size: 14px;
    color: #ccc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .times {
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: #fff;
    text-align: right;
  }

  .times.empty { color: #444; font-weight: 400; }

  .dot { color: #3a3a3a; margin: 0 5px; }

  .unit { font-size: 10px; color: #666; margin-left: 1px; }

  .arr { color: #ff5c5c; font-size: 11px; font-weight: 800; letter-spacing: 0.04em; }

  .footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #1a1a1a;
    font-size: 10px;
    color: #383838;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .loading { color: #444; font-size: 13px; text-align: center; padding: 12px 0; }
  .error   { color: #ff5c5c; font-size: 12px; text-align: center; padding: 12px 0; }
`;

class MtaTransitCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._data   = {};   // key: `${stop_id}::${route_id}` → PredictionSummary[]
    this._state  = "loading";   // "loading" | "ok" | "error"
    this._lastUpdate = null;
    this._timer  = null;
  }

  setConfig(config) {
    if (!config.api_url) throw new Error("mta-transit-card: api_url is required");
    if (!config.stops?.length) throw new Error("mta-transit-card: stops[] is required");
    this._config = config;
  }

  // Called by HA on every state change — use as the heartbeat to render
  // (actual data comes from our own fetch loop, not HA entities)
  set hass(/** @type {unknown} */ _hass) {
    if (!this._timer) this._startFetching();
  }

  connectedCallback() {
    if (this._config && !this._timer) this._startFetching();
  }

  disconnectedCallback() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _startFetching() {
    this._fetchAll();
    const interval = (this._config.refresh_seconds ?? 30) * 1000;
    this._timer = setInterval(() => this._fetchAll(), interval);
  }

  async _fetchAll() {
    const { api_url, metro_id = "mta", stops } = this._config;
    const calls = [];

    for (const stop of stops) {
      for (const route of stop.routes) {
        calls.push(this._fetchRoute(api_url, metro_id, stop, route));
      }
    }

    await Promise.all(calls);
    this._lastUpdate = new Date();
    this._state = "ok";
    this._render();
  }

  async _fetchRoute(apiUrl, metroId, stop, route) {
    const dir = (route.direction !== null && route.direction !== undefined) ? route.direction : "any";
    const key = `${stop.stop_id}::${route.route_id}::${dir}`;
    try {
      const resp = await fetch(`${apiUrl}/metros/${metroId}/predictions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stop_id:    stop.stop_id,
          routes:     [route.route_id],
          direction:  route.direction ?? null,
          limit:      this._config.predictions_per_route ?? 3,
          route_type: route.route_type ?? null,
        }),
      });

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      this._data[key] = json.predictions ?? [];
    } catch (err) {
      console.warn(`[mta-transit-card] fetch failed for ${key}:`, err);
      if (!(key in this._data)) this._data[key] = null;   // null = errored, [] = no trains
    }
  }

  _render() {
    const { stops } = this._config;
    const nowEpoch = Math.floor(Date.now() / 1000);
    let stopsHtml = "";

    for (const stop of stops) {
      const icon = stop.type === "bus" ? "🚌" : "🚇";
      let routesHtml = "";

      for (const route of stop.routes) {
        const dir  = (route.direction !== null && route.direction !== undefined) ? route.direction : "any";
        const key  = `${stop.stop_id}::${route.route_id}::${dir}`;
        const preds = this._data[key];
        const { bg, text } = lineStyle(route.route_id);
        const pill = !isBullet(route.route_id);

        const bulletHtml = pill
          ? `<div class="pill" style="background:${bg};color:${text}">${route.route_id}</div>`
          : `<div class="bullet" style="background:${bg};color:${text}">${route.route_id}</div>`;

        let headsign = "";
        let timesHtml = "";

        if (preds == null) {
          timesHtml = `<span class="times empty">—</span>`;
        } else if (preds.length === 0) {
          timesHtml = `<span class="times empty">No service</span>`;
        } else {
          headsign = preds[0]?.headsign ?? route.headsign ?? "";
          const parts = preds
            .filter(p => p.arrival_time)
            .slice(0, 3)
            .map(p => formatMinutes(p.arrival_time, nowEpoch));
          timesHtml = `<span class="times">${parts.join('<span class="dot">·</span>')}</span>`;
        }

        routesHtml += `
          <div class="route-row">
            ${bulletHtml}
            <div class="headsign">${headsign}</div>
            ${timesHtml}
          </div>`;
      }

      stopsHtml += `
        <div class="stop">
          <div class="stop-header">
            <span class="stop-icon">${icon}</span>
            <span class="stop-name">${stop.stop_name}</span>
          </div>
          ${routesHtml}
        </div>`;
    }

    const updatedStr = this._lastUpdate
      ? this._lastUpdate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "…";

    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <div class="board">
        ${stopsHtml}
        <div class="footer">
          <span>MTA Transit</span>
          <span>Updated ${updatedStr}</span>
        </div>
      </div>`;
  }

  getCardSize() {
    return (this._config?.stops?.length ?? 1) * 2;
  }
}

customElements.define("mta-transit-card", MtaTransitCard);

window.customCards ??= [];
window.customCards.push({
  type:        "mta-transit-card",
  name:        "MTA Transit Card",
  description: "NYC subway and bus arrival countdowns",
  preview:     true,
});
