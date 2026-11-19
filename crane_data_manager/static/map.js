/* Live Map - "Crane Yard" live data twin, in the Engineering City look.
   Isometric yard: every lane a pair of rails with container stacks, every
   crane a 3D ARMG at its live gantry position (trolley and hoist move too).
   Real packets flow as light from each crane over the Westermo router to the
   collector building and on to the NAS (InfluxDB). Blocked intruder packets
   stop in red at the collector. Pure SVG, no libraries, works offline. */
"use strict";
const SVGNS = "http://www.w3.org/2000/svg";
const CT = {
  ok: "#5ef0a0", idle: "#4d6a7d", off: "#3a4f5e", warn: "#ffb547", alarm: "#ff6b6b", cyan: "#3fd0ff",
  prog: {Retrofit: "#4aa3ff", New: "#b38cff", ZPMC: "#ff7fbf"},
  LANE_L: 600, LW: 40, LG: 24, TG: 70, CH: 60, CW: 11,
};
const isoP = (x, y, z) => [x + z * 0.866, -y - z * 0.5];
const isoPts = a => a.map(p => isoP(p[0], p[1], p[2]).map(v => v.toFixed(1)).join(",")).join(" ");
function sv(tag, attrs, parent, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const quad = (pts, at, par) => sv("polygon", Object.assign({points: isoPts(pts)}, at), par);
const iline = (a, b, at, par) => { const p = isoP(...a), q = isoP(...b); return sv("line", Object.assign({x1: p[0], y1: p[1], x2: q[0], y2: q[1]}, at), par); };
function box(x0, x1, y0, y1, z0, z1, c, par, edge) {   // front (z0), right side (x1), top
  const e = edge ? {stroke: edge, "stroke-width": .6, "stroke-opacity": .55} : {};
  quad([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], Object.assign({fill: c[0]}, e), par);
  quad([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], Object.assign({fill: c[1]}, e), par);
  quad([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], Object.assign({fill: c[2]}, e), par);
}
function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 1779033703; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; } return h >>> 0; }

const MapView = {
  mode: localStorage.getItem("cdm.mapmode2") || "yard",
  hiddenT: new Set(JSON.parse(localStorage.getItem("cdm.hiddenT") || "[]")),
  feed: [], prev: null, sceneSig: null, cranes: {}, particles: [], raf: null, replay: null, timer: null,
  vb: null, vb0: null, lastPos: {},
  layoutMode: localStorage.getItem("cdm.yardLayout") || "slots",   // slots | real
  focus: null,                                                      // null | w | c | n

  render(el) {
    el.innerHTML = `<div class="cty">
      <header class="cty-top">
        <div class="cty-logo">CY</div>
        <div class="cty-brand"><h1>Crane Yard</h1><small>Live data twin · PLC → collector → InfluxDB</small></div>
        <span id="ctyConn" class="cty-conn">CONNECTING…</span>
        <span class="grow"></span>
        <div id="ctyKpis" class="cty-kpis"></div>
        <nav class="cty-tabs" id="mapMode">${[["yard", "Yard"], ["network", "Data path"], ["replay", "Replay"]].map(([k, t]) => `<button data-m="${k}" class="${this.mode === k ? "on" : ""}">${t}</button>`).join("")}</nav>
      </header>
      <div class="cty-l">
        <aside class="cty-side">
          <div class="cty-panel" id="ctyCtx"><h4 id="ctyCtxH">Terminals &amp; lanes</h4><div id="ctyTerms"></div></div>
          <div class="cty-panel"><h4>Collector</h4><div id="ctyCol"></div></div>
          <div class="cty-panel"><h4>Live events</h4><div id="ctyFeed" class="cty-feed"></div></div>
        </aside>
        <div class="cty-main">
          <div id="replayBar" class="cty-panel hidden" style="margin-bottom:10px"></div>
          <div class="cty-wrap" id="ctyWrap">
            <div id="mapBox"></div>
            <div class="cty-layout" id="ctyLayout" title="How cranes are placed along the lane">
              <button data-l="slots" class="${this.layoutMode === "slots" ? "on" : ""}">Slots</button><button data-l="real" class="${this.layoutMode === "real" ? "on" : ""}">Real position</button></div>
            <div class="cty-zoom" id="ctyZoom"><button data-z="in" title="Zoom in">+</button><button data-z="out" title="Zoom out">−</button><button data-z="fit" title="Fit">⟲</button></div>
            <div class="cty-tip hidden" id="ctyTip"></div>
          </div>
          <div class="cty-legend">
            <span><i style="background:${CT.cyan}"></i>Packet arriving (one dot = one real packet)</span>
            <span><i style="background:${CT.alarm}"></i>Blocked packet (IP lock)</span>
            <span><i class="r" style="background:${CT.ok}"></i><i class="r" style="background:${CT.warn}"></i><i class="r" style="background:${CT.alarm}"></i>Beacon: crane health</span>
            <span>Girder band: <b style="color:${CT.prog.Retrofit}">Retrofit</b> · <b style="color:${CT.prog.New}">New</b> · <b style="color:${CT.prog.ZPMC}">ZPMC</b></span>
            <span class="muted">Scroll to zoom, drag to move, double-click to fit. Hover a crane for a summary, click it for details.</span>
          </div>
        </div>
      </div></div>`;
    $$("#mapMode button").forEach(b => b.onclick = () => {
      this.mode = b.dataset.m; localStorage.setItem("cdm.mapmode2", this.mode);
      $$("#mapMode button").forEach(x => x.classList.toggle("on", x === b));
      this.stopReplay(false); this.sceneSig = null; this.setupReplayBar(); this.update(App.live);
    });
    $$("#ctyZoom button").forEach(b => b.onclick = () => this.zoom(b.dataset.z === "in" ? 0.75 : b.dataset.z === "out" ? 1.33 : 0));
    $$("#ctyLayout button").forEach(b => b.onclick = () => {
      this.layoutMode = b.dataset.l; localStorage.setItem("cdm.yardLayout", this.layoutMode);
      $$("#ctyLayout button").forEach(x => x.classList.toggle("on", x === b));
      this.sceneSig = null; this.update(App.live);
    });
    this.sceneSig = null; this.prev = null; this.particles = [];
    this.setupReplayBar();
    this.startLoop();
  },
  leave() { cancelAnimationFrame(this.raf); this.raf = null; this.stopReplay(false); document.body.classList.remove("citymode"); },

  /* ── state helpers ── */
  group(c) { return ALARM_STATES.includes(c.state) ? "alarm" : WARN_STATES.includes(c.state) ? "warn" : c.state === "OK" ? "ok" : c.state === "OFF" ? "off" : "idle"; },
  col(c) { return CT[this.group(c)]; },
  sorted(cranes) { return [...cranes].sort((a, b) => (a.terminal + a.crane[0] + a.crane.slice(2)).localeCompare(b.terminal + b.crane[0] + b.crane.slice(2))); },

  update(live) {
    if (!$(".cty") || !live) return;
    $("#ctyZoom").classList.toggle("hidden", this.mode === "network");
    $("#ctyLayout").classList.toggle("hidden", this.mode !== "yard");
    this.panels(live);
    this.events(live);
    if (this.mode === "yard") { this.yard(live.cranes.filter(c => !this.hiddenT.has(c.terminal)), false); this.spawn(live); }
    else if (this.mode === "network") this.network(live);
    else if (this.mode === "replay" && !this.replay) $("#mapBox").innerHTML = `<div class="cty-empty">Choose a period and cranes above, then <b>Load replay</b>.</div>`;
    this.prev = {t: Date.now(), cranes: Object.fromEntries(live.cranes.map(c => [c.crane, {received: c.received || 0, dropped: c.dropped_ip || 0, state: c.state, not_written: c.not_written_off || 0}])),
      written: (live.writer || {}).written_total || 0, up: live.collector.up, healthy: (live.writer || {}).healthy, alarms: new Set(live.alarms.map(a => a.id))};
  },

  /* ── header KPIs, side panels, feed ── */
  panels(live) {
    const cr = live.cranes, w = live.writer || {}, c = live.collector;
    const liveN = cr.filter(x => x.live).length, pm = cr.reduce((s, x) => s + (x.pkt_min || 0), 0);
    const blocking = cr.filter(x => (x.recent_intruders || []).length).length;
    const kpi = (v, l, cls = "") => `<div class="cty-kpi ${cls}"><b>${v}</b><span>${l}</span></div>`;
    $("#ctyKpis").innerHTML =
      kpi(blocking ? `BLOCKING ${blocking}` : "PROTECTED", "IP lock", blocking ? "amb" : "ok") +
      kpi(`${liveN} / ${cr.length}`, "cranes live") + kpi(App.num(pm), "packets / min") +
      kpi(live.alarms.length, "alarms", live.alarms.length ? "red" : "") +
      kpi(App.num(w.written_total || 0), "written") +
      kpi(w.healthy === false ? "BUFFER " + App.num(w.buffered) : w.healthy ? "OK" : "–", "InfluxDB", w.healthy === false ? "red" : w.healthy ? "ok" : "");
    const conn = $("#ctyConn");
    conn.className = "cty-conn" + (c.up ? "" : " bad");
    conn.textContent = (c.up ? "LIVE " : "COLLECTOR DOWN ") + App.fmtTime(live.now, true, false);
    if (this.focus) { this.focusPanel(live); }
    else {
    $("#ctyCtxH").textContent = "Terminals & lanes";
    // terminals & lanes
    const all = App.live.cranes;
    const terms = Object.keys(App.meta.terminals).filter(t => !App.terminal || t === App.terminal);
    $("#ctyTerms").innerHTML = terms.map(t => {
      const tc = all.filter(x => x.terminal === t), on = tc.filter(x => x.live).length, al = tc.filter(x => this.group(x) === "alarm").length;
      const lanes = App.meta.terminals[t].lanes.split("");
      const dot = al ? CT.alarm : on ? CT.ok : tc.length ? CT.idle : "#2a3c4a";
      return `<label class="cty-brow ${this.hiddenT.has(t) ? "off" : ""}"><input type="checkbox" data-t="${t}" ${this.hiddenT.has(t) ? "" : "checked"}>
          <span class="bd" style="background:${dot};box-shadow:0 0 8px ${dot}"></span><span class="bn">${h(App.meta.terminals[t].name)}</span><em>${on}/${tc.length}</em></label>
        <div class="cty-bar"><div style="width:${tc.length ? 100 * on / tc.length : 0}%"></div></div>
        <div class="cty-lanes">${lanes.map(l => { const lc = tc.filter(x => x.crane[0] === l), lo = lc.filter(x => x.live).length, la = lc.some(x => this.group(x) === "alarm");
          return `<span title="Lane ${l}: ${lo} live / ${lc.length} registered" class="${la ? "al" : lo ? "on" : lc.length ? "reg" : ""}">${l}<i>${lc.length ? lo + "/" + lc.length : "–"}</i></span>`; }).join("")}</div>`;
    }).join("") + `<div class="cty-pbtns"><button class="cty-btn" data-all="1">Show all</button><button class="cty-btn" data-all="0">Hide all</button></div>`;
    $$("#ctyTerms input[data-t]").forEach(i => i.onchange = () => { i.checked ? this.hiddenT.delete(i.dataset.t) : this.hiddenT.add(i.dataset.t); this.saveHidden(); });
    $$("#ctyTerms [data-all]").forEach(b => b.onclick = () => { terms.forEach(t => b.dataset.all === "1" ? this.hiddenT.delete(t) : this.hiddenT.add(t)); this.saveHidden(); });
    }
    // collector panel
    const st = !c.up ? ["DOWN", "red", "The collector service does not answer - no data is being collected. The platform's watchdog is restarting it."] :
      w.healthy === false ? ["BUFFERING", "amb", `InfluxDB cannot be reached. ${App.num(w.buffered)} points are kept in the outage buffer and sent in order when it is back.`] :
      liveN ? ["COLLECTING", "ok", `${liveN} crane${liveN > 1 ? "s" : ""} sending · ${App.num(pm)} packets/min · every packet from an unregistered IP is blocked.`] :
      ["STANDBY", "", "Listening on every registered port. Cranes only send in Auto with an active work order."];
    $("#ctyCol").innerHTML = `<div class="cty-big ${st[1]}">${st[0]}</div><p>${st[2]}</p>
      <div class="cty-mini"><span>Listeners</span><b>${c.listeners ?? "–"}</b><span>Since</span><b>${c.started ? App.fmtTime(c.started, false) : "–"}</b><span>Buffer</span><b>${App.num(w.buffered || 0)}</b><span>Pending</span><b>${live.pending.length}</b></div>`;
  },
  /* ── context panel: Westermo / Collector PC / NAS ── */
  setFocus(k) {
    this.focus = this.focus === k ? null : k;
    this.markFocus();
    this.panels(App.live);
  },
  markFocus() { $$("#ctySvg .cty-bld").forEach(g => g.classList.toggle("sel", g.dataset.b === this.focus)); },
  focusPanel(live) {
    const M = App.meta, c = live.collector, w = live.writer || {}, cr = live.cranes;
    const liveN = cr.filter(x => x.live).length, pm = cr.reduce((s, x) => s + (x.pkt_min || 0), 0);
    const row = (k, v, cls = "") => `<span>${k}</span><b class="${cls}">${v}</b>`;
    const back = `<button class="cty-btn" id="fcBack" title="Back to terminals &amp; lanes">← Back</button>`;
    let title = "", html = "";
    if (this.focus === "w") {
      const blockedNow = cr.filter(x => (x.recent_intruders || []).length);
      const blockedTot = cr.reduce((s, x) => s + (x.dropped_ip || 0), 0);
      title = "Westermo router";
      html = `<div class="cty-big ${blockedNow.length ? "amb" : "ok"}">${blockedNow.length ? "BLOCKING " + blockedNow.length : "FORWARDING"}</div>
        <p>Forwards each crane's UDP port to the collector PC. The list shows what the crane register <b>expects</b> the router to forward - the platform cannot read the router's own rules, so a crane that never sends may also mean a missing rule on the Westermo.</p>
        <div class="cty-mini">${row("Router", h(M.westermo_ip || "–"))}${row("Forwards to", h(M.collector_ip || "–"))}${row("PLC send port", "4963 → crane port")}${row("Crane ports", cr.length)}${row("Packets / min", App.num(pm))}${row("Blocked (IP lock)", App.num(blockedTot), blockedTot ? "a" : "")}</div>
        <div class="cty-ftbl"><table><tr><th>Port</th><th>Crane</th><th>Registered IP</th><th>Now</th></tr>${[...cr].sort((a, b) => a.port - b.port).map(x => {
          const intr = (x.recent_intruders || []).length;
          return `<tr class="${intr ? "bad" : ""}" data-c="${h(x.crane)}"><td>${x.port}</td><td><b>${h(x.crane)}</b></td><td>${h(x.ip || "–")}</td><td><i style="background:${this.col(x)}"></i>${intr ? "✕ " + h(x.recent_intruders.join(", ")) : x.live ? (x.pkt_min || 0) + "/min" : h(STATE_SHORT[x.state] || x.state)}</td></tr>`;
        }).join("")}</table></div>
        <div class="cty-pbtns">${back}<button class="cty-btn" id="fcGo1">Crane register</button></div>`;
    } else if (this.focus === "c") {
      const st = !c.up ? ["DOWN", "red"] : w.healthy === false ? ["BUFFERING", "amb"] : liveN ? ["COLLECTING", "ok"] : ["STANDBY", ""];
      const up = c.started ? (Date.now() / 1000 - c.started) : 0;
      title = "Collector PC";
      html = `<div class="cty-big ${st[1]}">${st[0]}</div>
        <p>Windows service <b>CraneDataCollector</b> on ${h(M.collector_ip || "this PC")}: one UDP listener per crane port, IP lock, packet versions, outage buffer. It keeps running when this page is closed.</p>
        <div class="cty-mini">${row("Service", c.up ? "running · pid " + c.pid : "NOT RESPONDING", c.up ? "" : "r")}${row("Running since", c.started ? App.fmtTime(c.started) : "–")}${row("Uptime", up ? (up > 86400 ? (up / 86400).toFixed(1) + " days" : (up / 3600).toFixed(1) + " h") : "–")}
          ${row("Listeners", (c.listeners ?? "–") + (c.threads_ok === false ? " (one stopped!)" : ""))}${row("Cranes live", liveN + " / " + cr.length)}${row("Packets / min", App.num(pm))}
          ${row("Written since start", App.num(w.written_total || 0))}${row("Outage buffer", App.num(w.buffered || 0) + " (" + ((w.buffer_bytes || 0) / 1e6).toFixed(1) + " MB)", w.buffered ? "a" : "")}
          ${row("Rejected by InfluxDB", App.num(w.rejected_total || 0), w.rejected_total ? "a" : "")}${row("Waiting for refresh", live.pending.length ? h(live.pending.join(", ")) : "none", live.pending.length ? "a" : "")}
          ${row("Last reload", c.last_reload ? App.fmtTime(c.last_reload) : "–")}${row("Listening on", h(M.listen_address || "0.0.0.0") + " (UDP)")}</div>
        <div class="cty-pbtns">${back}<button class="cty-btn primary" id="fcRef">⟳ Refresh collector</button><button class="cty-btn" id="fcGo2">Settings</button></div>`;
    } else {
      const st = w.healthy === false ? ["UNREACHABLE", "red"] : w.healthy ? ["WRITES OK", "ok"] : ["WAITING", ""];
      title = "NAS · InfluxDB";
      html = `<div class="cty-big ${st[1]}">${st[0]}</div>
        <p>Every packet is stored here exactly as before (same bucket, measurement, tag and fields). If it cannot be reached, data waits in the collector's outage buffer and is sent in time order later.</p>
        <div class="cty-mini">${row("Address", h(M.influx_url || "–"))}${row("Organisation", h(M.influx_org || "–"))}${row("Bucket", h(M.influx_bucket || "–"))}${row("Measurement", h(M.influx_measurement || "–"))}${row("Tag", "crane_id")}
          ${row("Last write OK", w.last_ok ? App.ago(w.last_ok) : "–")}${row("Written since start", App.num(w.written_total || 0))}${row("Rejected points", App.num(w.rejected_total || 0), w.rejected_total ? "a" : "")}${row("Waiting in buffer", App.num(w.buffered || 0), w.buffered ? "a" : "")}</div>
        ${w.last_error ? `<p class="cty-err">Last error ${App.fmtTime(w.last_error_ts, true, false)}: ${h(w.last_error)}</p>` : ""}
        <p id="fcTestRes" class="small"></p>
        <div class="cty-pbtns">${back}<button class="cty-btn" id="fcTest">Test connection</button><button class="cty-btn" id="fcGo3">Settings</button></div>`;
    }
    $("#ctyCtxH").textContent = title;
    const keep = $("#fcTestRes") ? $("#fcTestRes").innerHTML : "";
    const sc = $("#ctyTerms .cty-ftbl") ? $("#ctyTerms .cty-ftbl").scrollTop : 0;
    $("#ctyTerms").innerHTML = html;
    if (sc && $("#ctyTerms .cty-ftbl")) $("#ctyTerms .cty-ftbl").scrollTop = sc;
    if (keep && $("#fcTestRes")) $("#fcTestRes").innerHTML = keep;
    const on = (id, fn) => { const b = $("#" + id); if (b) b.onclick = fn; };
    on("fcBack", () => this.setFocus(this.focus));
    on("fcGo1", () => location.hash = "#config/cranes");
    on("fcGo2", () => location.hash = "#config/collector");
    on("fcGo3", () => location.hash = "#config/influx");
    on("fcRef", () => Config.refreshCollector());
    on("fcTest", async () => {
      $("#fcTestRes").textContent = "testing…";
      try { const r = await App.api("/api/influx/test", {json: {}}); $("#fcTestRes").innerHTML = r.ok ? `<span style="color:${CT.ok}">✓ reachable · ${h(r.message || "")} · bucket ${h(r.bucket || "")}</span>` : `<span style="color:${CT.alarm}">✕ ${h(r.message)}</span>`; }
      catch (e) { $("#fcTestRes").innerHTML = `<span style="color:${CT.alarm}">✕ ${h(e.message)}</span>`; }
    });
    $$("#ctyTerms tr[data-c]").forEach(tr => tr.onclick = () => App.openCrane(tr.dataset.c));
  },

  saveHidden() { localStorage.setItem("cdm.hiddenT", JSON.stringify([...this.hiddenT])); this.sceneSig = null; this.update(App.live); },

  events(live) {
    const p = this.prev, now = App.fmtTime(live.now, true, false), push = (cls, t) => this.feed.unshift({t: now, cls, text: t});
    if (!p) { if (!this.feed.length) push("c", `Watching ${live.cranes.length} cranes on ${live.collector.listeners ?? "?"} ports`); }
    else {
      if (p.up !== live.collector.up) push(live.collector.up ? "g" : "r", live.collector.up ? "Collector service is back" : "COLLECTOR SERVICE DOWN");
      const wh = (live.writer || {}).healthy;
      if (p.healthy !== wh && wh !== null && wh !== undefined) push(wh ? "g" : "r", wh ? "InfluxDB writes OK again" : "InfluxDB unreachable - buffering");
      live.cranes.forEach(c => {
        const o = p.cranes[c.crane];
        if (!o || o.state === c.state) return;
        const g = this.group(c);
        if (c.state === "OK" && o.state === "IDLE") push("g", `${c.crane} started sending`);
        else if (c.state === "IDLE" && o.state === "OK") push("", `${c.crane} idle (job finished / not in Auto)`);
        else push(g === "alarm" ? "r" : g === "warn" ? "w" : g === "ok" ? "g" : "", `${c.crane} ${(STATE_TEXT[c.state] || c.state).toLowerCase()}`);
      });
      live.alarms.filter(a => !p.alarms.has(a.id)).forEach(a => push("r", `ALARM ${a.crane || ""} ${a.type.replace(/_/g, " ")}`));
    }
    this.feed.length = Math.min(this.feed.length, 9);
    $("#ctyFeed").innerHTML = this.feed.map(f => `<div class="${f.cls}"><span class="t">${f.t}</span>${h(f.text)}</div>`).join("");
  },

  /* ════════ the 3D yard ════════ */
  layout(cranes) {
    const terms = [...new Set(cranes.map(c => c.terminal))].sort();
    if (!terms.length) { const t = App.terminal || Object.keys(App.meta.terminals)[0]; if (!this.hiddenT.has(t)) terms.push(t); }
    const lanes = [];
    let z = 0;
    terms.forEach(t => {
      const cfg = App.meta.terminals[t] || {lanes: "ABCDE"};
      const ls = [...new Set(cfg.lanes.split("").concat(cranes.filter(c => c.terminal === t).map(c => c.crane[0])))].sort();
      const z0 = z;
      ls.forEach(l => { lanes.push({t, l, z0: z, key: t + l}); z += CT.LW + CT.LG; });
      lanes.filter(x => x.t === t).forEach(x => x.tz0 = z0);
      lanes.filter(x => x.t === t).forEach(x => x.tz1 = z - CT.LG);
      z += CT.TG;
    });
    return {terms, lanes, zMax: Math.max(z - CT.TG - CT.LG, 60)};
  },

  gx(g) {
    const yd = App.meta.yard, lo = yd.gantry_min, hi = Math.max(yd.gantry_max, this.gmax || 0);
    return (Math.min(Math.max(g, lo), hi) - lo) / (hi - lo) * CT.LANE_L;
  },

  laneSlots(t, lane) {
    const cfg = App.meta.terminals[t] || {};
    const n = +((cfg.lane_counts || {})[lane] || cfg.cranes_per_lane || 14);
    const reg = (App.live ? App.live.cranes : []).filter(c => c.terminal === t && c.crane[0] === lane).map(c => +c.crane.slice(2) || 0);
    return Math.max(n, ...reg, 1);
  },
  slotX(t, lane, num) { const n = this.laneSlots(t, lane); return 14 + (num - 0.5) / n * (CT.LANE_L - 28); },

  yard(cranes, isReplay) {
    const L = this.layout(cranes);
    const slots = this.layoutMode === "slots" && !isReplay;
    cranes.forEach(c => { const g = (c.values || {}).In_GANTRY1; if (typeof g === "number" && g > (this.gmax || App.meta.yard.gantry_max)) this.gmax = Math.ceil(g / 100) * 100 + 100; });
    const sig = (isReplay ? "R" : "L") + (slots ? "S" : "P") + JSON.stringify([L.lanes.map(l => l.key), cranes.map(c => c.crane), this.gmax]);
    this.slotsOn = slots;
    if (sig !== this.sceneSig || !$("#ctySvg")) { this.sceneSig = sig; this.build(L, cranes, isReplay); }
    this.L = L;
    const parked = {};
    cranes.forEach(c => {
      const o = this.cranes[c.crane];
      if (!o) return;
      const v = c.values || {};
      let g = v.In_GANTRY1 ?? v.In_GANTRY2;
      if (typeof g === "number") this.lastPos[c.crane] = g; else g = this.lastPos[c.crane];
      const lk = o.lane.key;
      o.hasPos = typeof g === "number";
      o.g_m = o.hasPos ? g : null;
      o.tx = slots ? this.slotX(c.terminal, c.crane[0], +c.crane.slice(2) || 1) :
        (o.hasPos ? this.gx(g) : CT.LANE_L - 14 - 34 * (parked[lk] = (parked[lk] ?? -1) + 1));
      const yd = App.meta.yard;
      o.tt = typeof v.In_TROLLEYPOMUX === "number" ? Math.min(Math.max(v.In_TROLLEYPOMUX / yd.trolley_max, 0), 1) : (o.tt ?? 0.5);
      o.th = typeof v.In_HOIST === "number" ? Math.min(Math.max(v.In_HOIST / yd.hoist_max, 0), 1) : (o.th ?? 0.85);
      o.locked = !!v.TwistlockLocked;
      if (o.cx === undefined) { o.cx = o.tx; o.ct = o.tt; o.ch = o.th; }
      o.c = c;
      const col = this.col(c), grp = this.group(c);
      const ghost = !slots && !o.hasPos ? " ghost" : "";
      o.g.setAttribute("class", `ycrane st-${grp}${ghost}${this.focusCrane === c.crane ? " sel" : ""}`);
      o.gb.setAttribute("class", `ycrane-b st-${grp}${ghost}`);
      o.frame.forEach(e => e.setAttribute("stroke", grp === "ok" ? CT.cyan : col));
      o.beacon.setAttribute("fill", col); o.halo.setAttribute("fill", col);
      o.tag.textContent = c.crane;
      o.sub.textContent = isReplay ? (o.hasPos ? `${g.toFixed(0)} m · step ${v.Step ?? "–"}` : "no data") :
        slots ? (c.state === "OK" ? (o.hasPos ? `${g.toFixed(0)} m` : "OK") : (STATE_SHORT[c.state] || c.state)) :
        (c.state === "OK" ? "" : (STATE_SHORT[c.state] || c.state) + (o.hasPos ? "" : " · no pos."));
      o.sub.setAttribute("fill", grp === "ok" ? "#9fe9ff" : col);
      o.box.style.display = o.locked ? "" : "none";
    });
    if (!slots) {
      const MIN = CT.CW * 2 + 12, byLane = {};
      Object.values(this.cranes).forEach(o => (byLane[o.lane.key] = byLane[o.lane.key] || []).push(o));
      Object.values(byLane).forEach(list => {
        list.sort((a, b) => a.tx - b.tx);
        for (let i = 1; i < list.length; i++) list[i].tx = Math.max(list[i].tx, list[i - 1].tx + MIN);
        let hi = CT.LANE_L - 10;
        for (let i = list.length - 1; i >= 0; i--) { list[i].tx = Math.min(list[i].tx, hi); hi = list[i].tx - MIN; }
      });
    }
    this.infra(isReplay);
  },

  build(L, cranes, isReplay) {
    const box0 = $("#mapBox");
    box0.innerHTML = "";
    const svg = sv("svg", {id: "ctySvg", class: "cty-svg", xmlns: SVGNS}, box0);
    const defs = sv("defs", {}, svg);
    defs.innerHTML = `<filter id="cg1" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="cg2" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="5"/></filter>
      <linearGradient id="cfFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#16314a"/><stop offset="1" stop-color="#0b1825"/></linearGradient>
      <linearGradient id="cfBeam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5ef0a0" stop-opacity="0"/><stop offset="1" stop-color="#5ef0a0" stop-opacity=".55"/></linearGradient>`;
    const root = sv("g", {}, svg);
    this.content = [];
    this.svg = svg; this.root = root;
    const ground = sv("g", {}, root), flows = sv("g", {}, root), yardG = sv("g", {}, root), infra = sv("g", {}, root), pk = sv("g", {}, root), labels = sv("g", {}, root);
    this.content = [yardG, infra, labels];
    this.pkG = pk; this.labelsG = labels; this.cranes = {};
    const zMid = L.zMax / 2, X0 = -470, X1 = CT.LANE_L + 60, Z0 = -40, Z1 = L.zMax + 40;
    this.geo = {zMid, wx: -100, colX0: -300, colX1: -215, nasX0: -450, nasX1: -380};
    // blueprint ground plate + grid
    quad([[X0, 0, Z0], [X1, 0, Z0], [X1, 0, Z1], [X0, 0, Z1]], {fill: "#0a141d", stroke: "#1e4a63", "stroke-width": 1}, ground);
    quad([[X0, 0, Z0], [X1, 0, Z0], [X1, -10, Z0], [X0, -10, Z0]], {fill: "#0d1a25"}, ground);
    quad([[X1, 0, Z0], [X1, 0, Z1], [X1, -10, Z1], [X1, -10, Z0]], {fill: "#071017"}, ground);
    const grid = sv("g", {opacity: .5}, ground);
    for (let x = Math.ceil(X0 / 20) * 20; x <= X1; x += 20) iline([x, 0, Z0], [x, 0, Z1], {stroke: "#16384c", "stroke-width": x % 100 === 0 ? .9 : .35}, grid);
    for (let z = Math.ceil(Z0 / 20) * 20; z <= Z1; z += 20) iline([X0, 0, z], [X1, 0, z], {stroke: "#16384c", "stroke-width": z % 100 === 0 ? .9 : .35}, grid);
    // terminal pads
    L.terms.forEach(t => { const ls = L.lanes.filter(l => l.t === t); quad([[-14, .2, ls[0].tz0 - 10], [CT.LANE_L + 34, .2, ls[0].tz0 - 10], [CT.LANE_L + 34, .2, ls[0].tz1 + 10], [-14, .2, ls[0].tz1 + 10]], {fill: "#0e1c28", stroke: "#2a6f92", "stroke-width": .8, "stroke-opacity": .7, "stroke-dasharray": "6 4"}, ground); });
    // flows: lane trunks to the router, router to collector, collector to NAS
    const G = this.geo;
    this.trunk = {};
    L.lanes.forEach(l => {
      const zc = l.z0 + CT.LW / 2;
      const pts = [[-6, .6, zc], [-46, .6, zc], [-46, .6, zMid], [G.wx + 12, .6, zMid]];
      this.trunk[l.key] = pts;
      const d = "M" + pts.map(p => isoP(...p).map(v => v.toFixed(1)).join(",")).join(" L");
      sv("path", {d, fill: "none", stroke: "#3fd0ff", "stroke-width": 5, opacity: .06, filter: "url(#cg2)"}, flows);
      sv("path", {d, fill: "none", stroke: "#2a8fb8", "stroke-width": 1, opacity: .55, "stroke-dasharray": "2 5", class: "cty-dash"}, flows);
      // lane centre bus (packets run along it from the crane to the lane end)
      iline([0, .5, zc], [CT.LANE_L, .5, zc], {stroke: "#1f6f92", "stroke-width": .6, opacity: .35, "stroke-dasharray": "1 6"}, flows);
    });
    this.path2 = [[G.wx - 12, .6, zMid], [G.colX1 + 2, .6, zMid]];
    this.path3 = [[G.colX0 - 2, .6, zMid], [G.nasX1 + 2, .6, zMid]];
    [this.path2, this.path3].forEach((pts, i) => {
      const d = "M" + pts.map(p => isoP(...p).map(v => v.toFixed(1)).join(",")).join(" L");
      sv("path", {d, fill: "none", stroke: i ? "#5ef0a0" : "#3fd0ff", "stroke-width": 9, opacity: .10, filter: "url(#cg2)"}, flows);
      sv("path", {d, fill: "none", stroke: i ? "#2fbf86" : "#2a8fb8", "stroke-width": 1.6, opacity: .85, "stroke-dasharray": "3 4", class: "cty-dash", id: i ? "ctyP3" : "ctyP2"}, flows);
    });
    // lanes, back to front (bigger z first)
    const byLane = {};
    cranes.forEach(c => (byLane[c.terminal + c.crane[0]] = byLane[c.terminal + c.crane[0]] || []).push(c));
    [...L.lanes].sort((a, b) => b.z0 - a.z0).forEach((l, idx) => this.drawLane(l, byLane[l.key] || [], yardG, labels, idx === L.lanes.length - 1 || l.z0 === l.tz0));
    // infrastructure: router, collector building, NAS
    this.drawInfra(infra, labels);
    // terminal labels
    L.terms.forEach(t => {
      const ls = L.lanes.filter(l => l.t === t);
      const tc = cranes.filter(c => c.terminal === t);
      const lab = this.label(labels, [CT.LANE_L * 0.62, 6, ls[ls.length - 1].z0 + CT.LW], 80, `${(App.meta.terminals[t] || {}).name || t}`.toUpperCase(), `${tc.length} REGISTERED · LANES ${ls.map(x => x.l).join("")} · CLICK TO ZOOM`, CT.cyan, "tl_" + t);
      lab.style.cursor = "pointer";
      lab.addEventListener("click", () => { if (this.dragged) return; let b = null; $$("#ctySvg [data-t='" + t + "']").forEach(e => { const r = e.getBBox(); b = b ? {x: Math.min(b.x, r.x), y: Math.min(b.y, r.y), x2: Math.max(b.x2, r.x + r.width), y2: Math.max(b.y2, r.y + r.height)} : {x: r.x, y: r.y, x2: r.x + r.width, y2: r.y + r.height}; }); if (b) this.zoomTo({x: b.x, y: b.y, width: b.x2 - b.x, height: b.y2 - b.y}); });
    });
    this.fit();
    this.bindPanZoom();
  },

  drawLane(l, cranes, par, labels, front) {
    const g = sv("g", {"data-t": l.t}, par), z0 = l.z0, z1 = l.z0 + CT.LW, Lx = CT.LANE_L;
    const backG = sv("g", {"pointer-events": "none"}, g);   // crane back legs: behind the stacks
    // rails
    [z0 + 1.5, z1 - 1.5].forEach(z => { iline([-4, .4, z], [Lx + 8, .4, z], {stroke: "#3fd0ff", "stroke-width": 1.1, opacity: .55}, g); iline([-4, .4, z], [Lx + 8, .4, z], {stroke: "#3fd0ff", "stroke-width": 4, opacity: .07, filter: "url(#cg2)"}, g); });
    // container stacks between the rails (deterministic per lane)
    const R = rng(hashStr(l.key)), pal = [["#1c3547", "#132836", "#24445a"], ["#2b2f3b", "#1d2029", "#383d4b"], ["#3a2a24", "#281d19", "#4a3730"], ["#1f3a33", "#152923", "#2a4b42"]];
    for (let x = 6; x < Lx - 14; x += 18 + R() * 8) {
      if (R() < 0.35) continue;
      const len = 12 + R() * 3, tiers = 1 + Math.floor(R() * 3), c = pal[Math.floor(R() * pal.length)];
      for (const row of [0, 1]) { if (R() < 0.3) continue; const zz = z0 + 9 + row * 12; box(x, x + len, 0, tiers * 2.4, zz, zz + 10, c, g); }
    }
    // slot mode: a faint numbered pad for every crane position of the lane (shows the roster)
    if (this.slotsOn) {
      const n = this.laneSlots(l.t, l.l), have = new Set(cranes.map(c => +c.crane.slice(2)));
      for (let k = 1; k <= n; k++) {
        const x = this.slotX(l.t, l.l, k), digit = l.t.slice(-1);
        quad([[x - CT.CW, .5, z0 + 1], [x + CT.CW, .5, z0 + 1], [x + CT.CW, .5, z0 + CT.LW - 1], [x - CT.CW, .5, z0 + CT.LW - 1]],
          {fill: have.has(k) ? "rgba(63,208,255,.05)" : "none", stroke: "#2a6f92", "stroke-width": .6, "stroke-opacity": have.has(k) ? .5 : .35, "stroke-dasharray": "3 3"}, g);
        const q = isoP(x, 0, z0 - 6);
        sv("text", {x: q[0], y: q[1] + 3, class: "cty-slot" + (have.has(k) ? " on" : "")}, g, `${l.l}${digit}${String(k).padStart(2, "0")}`);
      }
    }
    // lane letter at the far end + gantry scale on the front lane of each terminal
    const p = isoP(Lx + 18, 0, z0 + CT.LW / 2);
    const lt = sv("text", {x: p[0], y: p[1] + 5, class: "cty-lane"}, g, l.l);
    lt.appendChild(sv("title", {}, null, `Lane ${l.l} - click to zoom in`));
    lt.addEventListener("click", e => { e.stopPropagation(); if (!this.dragged) this.zoomTo(g.getBBox()); });
    if (front && !this.slotsOn) {
      const yd = App.meta.yard, hi = Math.max(yd.gantry_max, this.gmax || 0);
      for (let gm = Math.ceil(yd.gantry_min / 500) * 500; gm <= hi; gm += 500) { const x = this.gx(gm); iline([x, .3, z0 - 2], [x, .3, z0 - 6], {stroke: "#2a6f92", "stroke-width": .8}, g); const q = isoP(x, 0, z0 - 9); sv("text", {x: q[0], y: q[1] + 3, class: "cty-tick"}, g, gm + " m"); }
    }
    // cranes of this lane (same z: no overlap issues, cranes in one lane never pass each other)
    cranes.sort((a, b) => a.crane.localeCompare(b.crane)).forEach(c => this.drawCrane(c, l, g, labels, backG));
  },

  drawCrane(c, l, par, labels, backPar) {
    const z0 = l.z0, LW = CT.LW, H = CT.CH, W = CT.CW;
    const gb = sv("g", {class: "ycrane-b"}, backPar);
    const g = sv("g", {class: "ycrane", "data-c": c.crane}, par);
    const frame = [];
    const st = {"stroke-width": 2.2, "stroke-linecap": "round"};
    // back legs + sill + diagonal brace (separate layer, drawn before the container stacks)
    frame.push(iline([-W, 0, z0 + LW], [-W, H, z0 + LW], st, gb), iline([W, 0, z0 + LW], [W, H, z0 + LW], st, gb));
    frame.push(iline([-W, 2, z0 + LW], [W, 2, z0 + LW], {"stroke-width": 1.4}, gb));
    frame.push(iline([-W, H * .55, z0 + LW], [W, H * .85, z0 + LW], {"stroke-width": .9, opacity: .6}, gb));
    // girder deck
    quad([[-W - 1.5, H, z0 - 4], [W + 1.5, H, z0 - 4], [W + 1.5, H, z0 + LW + 4], [-W - 1.5, H, z0 + LW + 4]], {fill: "#0f2232", stroke: "#3fd0ff", "stroke-opacity": .4, "stroke-width": .6}, g);
    quad([[-W - 1.5, H - 3.5, z0 - 4], [W + 1.5, H - 3.5, z0 - 4], [W + 1.5, H, z0 - 4], [-W - 1.5, H, z0 - 4]], {fill: "#16314a"}, g);
    quad([[W + 1.5, H - 3.5, z0 - 4], [W + 1.5, H - 3.5, z0 + LW + 4], [W + 1.5, H, z0 + LW + 4], [W + 1.5, H, z0 - 4]], {fill: "#0c1a28"}, g);
    // program band on the girder side + machinery house
    quad([[W + 1.6, H - 3, z0 + 2], [W + 1.6, H - 3, z0 + LW - 2], [W + 1.6, H - .8, z0 + LW - 2], [W + 1.6, H - .8, z0 + 2]], {fill: CT.prog[c.program] || "#5d7d90", opacity: .95}, g);
    box(-5.5, 5.5, H, H + 7, z0 + LW - 11, z0 + LW - 2, ["#18304a", "#0e1c2a", "#1f3b56"], g, "#3fd0ff");
    // trolley (moves across the lane) with ropes and spreader (moves up/down)
    const tg = sv("g", {class: "ytrolley"}, g);
    box(-6.5, 6.5, H, H + 4.5, z0 - 3.5, z0 + 3.5, ["#1f8fd6", "#176fae", "#3fd0ff"], tg);
    const rope1 = sv("line", {stroke: "#9fc3d6", "stroke-width": .7}, tg), rope2 = sv("line", {stroke: "#9fc3d6", "stroke-width": .7}, tg);
    const spr = sv("g", {}, tg);
    box(-7.5, 7.5, 0, 1.5, z0 - 2.2, z0 + 2.2, ["#d48a1e", "#a86a12", "#ffb547"], spr);
    const cbox = sv("g", {}, spr);
    box(-9.5, 9.5, -7.5, -.3, z0 - 3, z0 + 3, ["#2f5a78", "#214358", "#3d7398"], cbox, "#3fd0ff");
    // front legs + sill (drawn last: in front)
    frame.push(iline([-W, 0, z0], [-W, H, z0], st, g), iline([W, 0, z0], [W, H, z0], st, g));
    frame.push(iline([-W, 2, z0], [W, 2, z0], {"stroke-width": 1.4}, g));
    frame.push(iline([-W, H - 1.5, z0], [-W, H - 1.5, z0 + LW], {"stroke-width": 1.2}, g), iline([W, H - 1.5, z0], [W, H - 1.5, z0 + LW], {"stroke-width": 1.2}, g));
    // beacon + tag
    const bp = isoP(0, H + 12, z0 + LW / 2);
    const halo = sv("circle", {cx: bp[0], cy: bp[1], r: 10, opacity: .3, filter: "url(#cg2)", class: "yhalo"}, g);
    const beacon = sv("circle", {cx: bp[0], cy: bp[1], r: 3.4, filter: "url(#cg1)"}, g);
    iline([0, H + 7, z0 + LW / 2], [0, H + 10.5, z0 + LW / 2], {stroke: "#5b7a8e", "stroke-width": 1}, g);
    const tag = sv("text", {x: bp[0], y: bp[1] - 8, class: "ytag"}, g, c.crane);
    const sub = sv("text", {x: bp[0], y: bp[1] - 21, class: "ysub"}, g, "");
    const hit = sv("rect", {x: bp[0] - 16, y: bp[1] - 20, width: 46, height: 96, fill: "transparent"}, g);
    g.addEventListener("mouseenter", e => this.tip(c.crane, e));
    g.addEventListener("mousemove", e => this.tipMove(e));
    g.addEventListener("mouseleave", () => $("#ctyTip").classList.add("hidden"));
    g.addEventListener("click", () => { if (!this.dragged) App.openCrane(c.crane); });
    this.cranes[c.crane] = {g, gb, tg, spr, box: cbox, rope1, rope2, frame, beacon, halo, tag, sub, lane: l, z0, H};
  },

  drawInfra(par0, labels) {
    const G = this.geo, z = G.zMid;
    const bg = k => { const g = sv("g", {class: "cty-bld", "data-b": k}, par0); g.addEventListener("click", e => { e.stopPropagation(); if (!this.dragged) this.setFocus(k); }); return g; };
    // Westermo router
    let par = bg("w");
    box(G.wx - 15, G.wx + 15, 0, 9, z - 11, z + 11, ["#0f5c55", "#0a3f3a", "#147a70"], par, "#5ef0a0");
    for (let i = 0; i < 4; i++) { const q = isoP(G.wx - 10 + i * 6, 5, z - 11.1); sv("circle", {cx: q[0], cy: q[1], r: 1.1, fill: i < 2 ? "#5ef0a0" : "#ffb547", class: "cty-led"}, par); }
    this.label(labels, [G.wx, 10, z + 9], 46, "WESTERMO", "PORT FORWARD → .237", CT.ok, "lab_w");
    // Collector PC building with beam
    par = bg("c");
    const x0 = G.colX0, x1 = G.colX1, zz0 = z - 32, zz1 = z + 32, Hb = 58;
    quad([[x0, 0, zz0], [x1, 0, zz0], [x1, Hb, zz0], [x0, Hb, zz0]], {fill: "url(#cfFront)", stroke: "#3fd0ff", "stroke-opacity": .5, "stroke-width": .8}, par);
    quad([[x1, 0, zz0], [x1, 0, zz1], [x1, Hb, zz1], [x1, Hb, zz0]], {fill: "#0b1824", stroke: "#3fd0ff", "stroke-opacity": .5, "stroke-width": .8}, par);
    this.colRibs = [];
    for (let i = 0; i < 4; i++) {
      const y = 6 + i * 13;
      this.colRibs.push(quad([[x0 + 4, y, zz0 - .2], [x1 - 4, y, zz0 - .2], [x1 - 4, y + 7, zz0 - .2], [x0 + 4, y + 7, zz0 - .2]], {fill: "#20384c", class: "cty-rib"}, par));
      quad([[x1 + .2, y, zz0 + 4], [x1 + .2, y, zz1 - 4], [x1 + .2, y + 7, zz1 - 4], [x1 + .2, y + 7, zz0 + 4]], {fill: "#162a3a"}, par);
      for (let x = x0 + 12; x < x1 - 4; x += 8) iline([x, y, zz0 - .3], [x, y + 7, zz0 - .3], {stroke: "#0b1622", "stroke-width": 1.2}, par);
    }
    quad([[x0, Hb, zz0], [x1, Hb, zz0], [x1, Hb, zz1], [x0, Hb, zz1]], {fill: "#11202d", stroke: "#3fd0ff", "stroke-opacity": .4, "stroke-width": .7}, par);
    box((x0 + x1) / 2 - 7, (x0 + x1) / 2 + 7, Hb, Hb + 26, z - 7, z + 7, ["#132a3c", "#0b1824", "#1d3245"], par, "#3fd0ff");
    const bt = isoP((x0 + x1) / 2, Hb + 26, z), bTop = isoP((x0 + x1) / 2, Hb + 160, z);
    this.beam = sv("polygon", {points: `${bt[0] - 6},${bt[1]} ${bt[0] + 6},${bt[1]} ${bTop[0] + 16},${bTop[1]} ${bTop[0] - 16},${bTop[1]}`, fill: "url(#cfBeam)", class: "cty-beam"}, par);
    this.colBeacon = sv("circle", {cx: bt[0], cy: bt[1] - 3, r: 3.2, fill: CT.ok, filter: "url(#cg1)", class: "cty-pulse"}, par);
    this.colRing = sv("ellipse", {cx: bt[0], cy: bt[1] - 1, rx: 12, ry: 6, fill: "none", stroke: CT.ok, "stroke-width": 1.2, opacity: .7, filter: "url(#cg1)"}, par);
    // IP-lock gate (blocked packets stop here)
    const gp = isoP(x1 + 6, 2, z);
    this.gate = sv("circle", {cx: gp[0], cy: gp[1], r: 5, fill: "none", stroke: CT.alarm, "stroke-width": 1.4, opacity: 0, filter: "url(#cg1)"}, par0);
    this.label(labels, [(x0 + x1) / 2, Hb + 30, zz1], 64, "COLLECTOR PC", "", CT.ok, "lab_c");
    // NAS / InfluxDB
    par = bg("n");
    const n0 = G.nasX0, n1 = G.nasX1, nz0 = z - 26, nz1 = z + 26, Hn = 34;
    quad([[n0, 0, nz0], [n1, 0, nz0], [n1, Hn, nz0], [n0, Hn, nz0]], {fill: "url(#cfFront)", stroke: "#5ef0a0", "stroke-opacity": .45, "stroke-width": .8}, par);
    quad([[n1, 0, nz0], [n1, 0, nz1], [n1, Hn, nz1], [n1, Hn, nz0]], {fill: "#0b1824", stroke: "#5ef0a0", "stroke-opacity": .45, "stroke-width": .8}, par);
    for (let i = 0; i < 3; i++) quad([[n0 + 4, 5 + i * 9, nz0 - .2], [n1 - 4, 5 + i * 9, nz0 - .2], [n1 - 4, 10 + i * 9, nz0 - .2], [n0 + 4, 10 + i * 9, nz0 - .2]], {fill: "#1a3a34", class: "cty-rib2"}, par);
    quad([[n0, Hn, nz0], [n1, Hn, nz0], [n1, Hn, nz1], [n0, Hn, nz1]], {fill: "#11202d"}, par);
    const dc = isoP((n0 + n1) / 2, Hn, z);
    for (let i = 0; i < 3; i++) { sv("ellipse", {cx: dc[0], cy: dc[1] - i * 7, rx: 18, ry: 9, fill: i === 2 ? "#1f4a42" : "#163a34", stroke: "#5ef0a0", "stroke-opacity": .6, "stroke-width": .8}, par); }
    this.nasGlow = sv("ellipse", {cx: dc[0], cy: dc[1] - 14, rx: 18, ry: 9, fill: "#5ef0a0", opacity: .15, filter: "url(#cg2)"}, par);
    this.label(labels, [(n0 + n1) / 2, Hn + 22, nz1], 54, "NAS · INFLUXDB", "", CT.ok, "lab_n");
    [["lab_w", "w"], ["lab_c", "c"], ["lab_n", "n"]].forEach(([id, k]) => { const e = document.getElementById(id); e.style.cursor = "pointer"; e.addEventListener("click", ev => { ev.stopPropagation(); if (!this.dragged) this.setFocus(k); }); });
    this.markFocus();
  },

  label(par, anchor, lift, title, sub, color, id) {
    const a = isoP(...anchor), y = a[1] - lift;
    const g = sv("g", {class: "cty-label", id}, par);
    sv("line", {x1: a[0], y1: a[1], x2: a[0], y2: y + 22, stroke: color, "stroke-opacity": .5, "stroke-dasharray": "2 3", "stroke-width": .8, class: "ll"}, g);
    const w = Math.max(title.length * 7.4, (sub || "").length * 5.2) + 22;
    sv("rect", {x: a[0] - 10, y, width: w, height: 25, rx: 2, fill: "rgba(8,18,28,.9)", stroke: "rgba(63,208,255,.45)", "stroke-width": .8, class: "lb"}, g);
    sv("rect", {x: a[0] - 10, y, width: 2.6, height: 25, fill: color, class: "lc"}, g);
    sv("text", {x: a[0] - 2, y: y + 11, class: "cty-lt"}, g, title);
    sv("text", {x: a[0] - 2, y: y + 20.5, class: "cty-ls"}, g, sub || "");
    return g;
  },
  setLabel(id, sub, color) {
    const g = document.getElementById(id);
    if (!g) return;
    $(".cty-ls", g).textContent = sub;
    if (color) { $(".lc", g).setAttribute("fill", color); $(".ll", g).setAttribute("stroke", color); }
    const t = $(".cty-lt", g).textContent;
    $(".lb", g).setAttribute("width", Math.max(t.length * 7.4, sub.length * 5.2) + 22);
  },

  infra(isReplay) {
    const live = App.live;
    if (!live || !this.colRibs) return;
    const c = live.collector, w = live.writer || {};
    const liveN = live.cranes.filter(x => x.live).length;
    const colC = !c.up ? CT.alarm : w.healthy === false ? CT.warn : CT.ok;
    this.colBeacon.setAttribute("fill", colC); this.colRing.setAttribute("stroke", colC);
    this.beam.style.opacity = c.up && liveN && !isReplay ? 1 : 0;
    this.colRibs.forEach((r, i) => r.setAttribute("fill", c.up ? (i < Math.ceil(4 * Math.min(1, liveN / Math.max(1, live.cranes.length)) + (liveN ? 1 : 0)) ? "#2a8fb8" : "#20384c") : "#3a1a1e"));
    this.setLabel("lab_c", !c.up ? "DOWN · NOT COLLECTING" : `${liveN} LIVE · ${App.num(live.cranes.reduce((s, x) => s + (x.pkt_min || 0), 0))} PKT/MIN`, colC);
    this.setLabel("lab_n", w.healthy === false ? `UNREACHABLE · BUFFER ${App.num(w.buffered)}` : w.healthy ? `WRITES OK · ${App.num(w.written_total)}` : "WAITING FOR DATA", w.healthy === false ? CT.alarm : CT.ok);
    this.nasGlow.setAttribute("fill", w.healthy === false ? CT.alarm : CT.ok);
    const blocking = live.cranes.some(x => (x.recent_intruders || []).length);
    this.gate.setAttribute("opacity", blocking ? .9 : 0);
    // alarm callouts above cranes in alarm
    $$(".cty-label.crane", this.labelsG).forEach(e => e.remove());
    Object.values(this.cranes).forEach(o => o.alarmLabel = null);
    live.cranes.filter(x => this.group(x) === "alarm" && this.cranes[x.crane]).forEach(x => {
      const o = this.cranes[x.crane];
      const g = this.label(this.labelsG, [o.cx ?? 0, CT.CH + 10, o.z0 + CT.LW / 2], 34, `${x.crane} · ${(STATE_SHORT[x.state] || x.state).toUpperCase()}`,
        x.state === "IP_CONFLICT" ? "BLOCKED " + (x.recent_intruders || []).join(", ") : x.state === "WRONG_SIZE" ? `SIZE ${x.last_wrong_size || x.last_size} ≠ ${x.expected_size}` : "", CT.alarm, "al_" + x.crane);
      g.classList.add("crane");
      o.alarmLabel = g; o.alarmX = o.cx ?? 0;
    });
  },

  /* ── animation loop: crane motion + packet particles ── */
  startLoop() {
    let last = performance.now();
    const step = (now) => {
      if (App.view !== "map") { this.raf = null; return; }
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.mode !== "network") this.animate(dt, now);
      this.raf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(step);
  },
  animate(dt, now) {
    const k = 1 - Math.exp(-dt / 0.55);
    Object.values(this.cranes).forEach(o => {
      if (o.tx === undefined) return;
      o.cx += (o.tx - o.cx) * k; o.ct += (o.tt - o.ct) * k; o.ch += (o.th - o.ch) * k;
      o.g.setAttribute("transform", `translate(${o.cx.toFixed(2)},0)`);
      o.gb.setAttribute("transform", `translate(${o.cx.toFixed(2)},0)`);
      const dz = o.ct * (CT.LW - 8) + 4;
      o.tg.setAttribute("transform", `translate(${(dz * 0.866).toFixed(2)},${(-dz * 0.5).toFixed(2)})`);
      const sy = 9 + o.ch * (o.H - 16);
      o.spr.setAttribute("transform", `translate(0,${(-sy).toFixed(2)})`);
      const a = isoP(-4, o.H, o.z0), b = isoP(-4, sy + 1.5, o.z0), c = isoP(4, o.H, o.z0), d = isoP(4, sy + 1.5, o.z0);
      o.rope1.setAttribute("x1", a[0]); o.rope1.setAttribute("y1", a[1]); o.rope1.setAttribute("x2", b[0]); o.rope1.setAttribute("y2", b[1]);
      o.rope2.setAttribute("x1", c[0]); o.rope2.setAttribute("y1", c[1]); o.rope2.setAttribute("x2", d[0]); o.rope2.setAttribute("y2", d[1]);
      if (o.alarmLabel) o.alarmLabel.setAttribute("transform", `translate(${(o.cx - (o.alarmX ?? o.cx)).toFixed(2)},0)`);
    });
    // particles
    const t = now / 1000;
    this.particles = this.particles.filter(p => {
      const u = (t - p.t0) / p.dur;
      if (u < 0) { p.el.setAttribute("opacity", 0); return true; }
      if (u >= 1) { p.el.remove(); if (p.burst) this.burst(p.end, p.color); return false; }
      const q = this.along(p.pts, p.lens, p.total, u);
      p.el.setAttribute("cx", q[0].toFixed(1)); p.el.setAttribute("cy", q[1].toFixed(1)); p.el.setAttribute("opacity", u > .92 ? (1 - u) * 12 : 1);
      return true;
    });
  },
  along(pts, lens, total, u) {
    let d = u * total;
    for (let i = 0; i < lens.length; i++) { if (d <= lens[i]) { const a = pts[i], b = pts[i + 1], f = lens[i] ? d / lens[i] : 0; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]; } d -= lens[i]; }
    return pts[pts.length - 1];
  },
  addParticle(world, color, delay, speed = 260, burst = false, r = 2.1) {
    if (!this.pkG || this.particles.length > 400) return;
    const pts = world.map(p => isoP(...p));
    const lens = []; let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); total += l; }
    const el = sv("circle", {r, fill: color, opacity: 0, filter: "url(#cg1)"}, this.pkG);
    this.particles.push({el, pts, lens, total, t0: performance.now() / 1000 + delay, dur: Math.max(.6, total / speed), color, burst, end: pts[pts.length - 1]});
  },
  burst(p, color) {
    const e = sv("circle", {cx: p[0], cy: p[1], r: 1, fill: "none", stroke: color, "stroke-width": 1.2, class: "cty-burst"}, this.pkG);
    setTimeout(() => e.remove(), 700);
  },
  spawn(live) {
    const p = this.prev;
    if (!p || !this.trunk || this.mode !== "yard") return;
    const G = this.geo;
    const gap = Math.min(3, (Date.now() - p.t) / 1000);
    live.cranes.forEach(c => {
      const o = this.cranes[c.crane], q = p.cranes[c.crane];
      if (!o || !q) return;
      const tr = this.trunk[o.lane.key];
      if (!tr) return;
      const zc = o.z0 + CT.LW / 2;
      const n = Math.min(4, Math.max(0, (c.received || 0) - q.received));
      const start = [o.cx ?? 0, 1, zc];
      const pathOk = [start, ...tr, ...this.path2];
      for (let i = 0; i < n; i++) this.addParticle(pathOk, c.enabled ? "#c9f6ff" : "#7f93a0", gap * i / Math.max(1, n));
      const nb = Math.min(4, Math.max(0, (c.dropped_ip || 0) - q.dropped));
      for (let i = 0; i < nb; i++) this.addParticle([[-6, 1, zc], ...tr.slice(1), [G.colX1 + 8, .6, G.zMid]], CT.alarm, gap * i / Math.max(1, nb), 240, true, 2.4);
    });
    const dw = Math.min(8, Math.max(0, ((live.writer || {}).written_total || 0) - p.written));
    if ((live.writer || {}).healthy !== false) for (let i = 0; i < dw; i++) this.addParticle(this.path3, "#c9ffe6", gap * i / Math.max(1, dw), 200);
  },

  /* ── hover tooltip ── */
  tip(crane, e) {
    const c = (App.live.cranes || []).find(x => x.crane === crane);
    if (!c) return;
    const v = c.values || {}, col = this.col(c);
    $("#ctyTip").innerHTML = `<b style="color:${col}">${h(crane)}</b> <span class="muted">· ${h(c.terminal)} · ${h(App.verLabel(c))}</span>
      <div class="tr"><span>State</span><b style="color:${col}">${h(STATE_TEXT[c.state] || c.state)}</b></div>
      <div class="tr"><span>Port · IP</span><b>${c.port} · ${h(c.ip || "–")}</b></div>
      <div class="tr"><span>Packets / min</span><b>${c.pkt_min || 0} · last ${App.ago(c.last_packet)}</b></div>
      ${typeof v.In_GANTRY1 === "number" ? `<div class="tr"><span>Gantry · trolley · hoist</span><b>${v.In_GANTRY1.toFixed(0)} · ${App.num(v.In_TROLLEYPOMUX, 1)} · ${App.num(v.In_HOIST, 1)} m</b></div>` : ""}
      ${v.WorkorderIdent !== undefined ? `<div class="tr"><span>Work order · step</span><b>${v.WorkorderIdent} · ${v.Step}</b></div>` : ""}
      ${(c.recent_intruders || []).length ? `<div class="tr"><span>Blocked IP</span><b style="color:${CT.alarm}">${h(c.recent_intruders.join(", "))}</b></div>` : ""}
      <div class="small muted" style="margin-top:4px">Click for details and actions</div>`;
    $("#ctyTip").classList.remove("hidden");
    this.tipMove(e);
  },
  tipMove(e) {
    const t = $("#ctyTip"), r = $("#ctyWrap").getBoundingClientRect();
    let x = e.clientX - r.left + 16, y = e.clientY - r.top + 12;
    if (x + 290 > r.width) x -= 310;
    t.style.left = x + "px"; t.style.top = y + "px";
  },

  /* ── view box: fit, zoom, pan ── */
  fit() {
    // fit to the yard, the buildings and the labels (not the empty ground margins)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    (this.content.length ? this.content : [this.root]).forEach(g => { const b = g.getBBox(); if (!b.width) return; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); });
    const pad = 24;
    this.vb0 = [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad];
    // frame height follows the scene shape (no big empty bands above and below)
    const w = this.svg.clientWidth || 1200;
    const hpx = Math.max(420, Math.min(window.innerHeight - 230, w * this.vb0[3] / this.vb0[2]));
    this.svg.style.height = Math.round(hpx) + "px";
    this.vb = this.vb0.slice();
    this.applyVB();
  },
  applyVB() {
    this.svg.setAttribute("viewBox", this.vb.map(v => v.toFixed(1)).join(" "));
    const k = this.vb[2] / (this.svg.clientWidth || 1200);
    this.svg.classList.toggle("far", k > 1.25);       // far away: hide the small texts
  },
  zoomTo(bb) {
    const pad = 30, r = this.svg.getBoundingClientRect(), asp = r.width / Math.max(1, r.height);
    let w = bb.width + 2 * pad, hh = bb.height + 2 * pad;
    if (w / hh < asp) w = hh * asp; else hh = w / asp;
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    this.vb = [cx - w / 2, cy - hh / 2, w, hh];
    this.applyVB();
  },
  zoom(f, cx, cy) {
    if (!this.vb) return;
    if (!f) { this.vb = this.vb0.slice(); return this.applyVB(); }
    const [x, y, w, hh] = this.vb, mx = cx ?? x + w / 2, my = cy ?? y + hh / 2;
    const nw = Math.min(this.vb0[2] * 1.6, Math.max(120, w * f)), nh = nw * hh / w;
    this.vb = [mx - (mx - x) * nw / w, my - (my - y) * nh / hh, nw, nh];
    this.applyVB();
  },
  bindPanZoom() {
    const svg = this.svg;
    const toVB = e => { const r = svg.getBoundingClientRect(), s = Math.max(this.vb[2] / r.width, this.vb[3] / r.height); const ox = (r.width * s - this.vb[2]) / 2, oy = (r.height * s - this.vb[3]) / 2; return [this.vb[0] + (e.clientX - r.left) * s - ox, this.vb[1] + (e.clientY - r.top) * s - oy, s]; };
    svg.addEventListener("wheel", e => { e.preventDefault(); const [mx, my] = toVB(e); this.zoom(e.deltaY < 0 ? 0.85 : 1.18, mx, my); }, {passive: false});
    let drag = null;
    svg.addEventListener("mousedown", e => { drag = {x: e.clientX, y: e.clientY, vb: this.vb.slice(), s: toVB(e)[2]}; this.dragged = false; });
    window.addEventListener("mousemove", e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) this.dragged = true; this.vb = [drag.vb[0] - dx * drag.s, drag.vb[1] - dy * drag.s, drag.vb[2], drag.vb[3]]; this.applyVB(); });
    window.addEventListener("mouseup", () => { drag = null; setTimeout(() => this.dragged = false, 0); });
    svg.addEventListener("dblclick", () => this.zoom(0));
  },

  /* ════════ data path (network) view ════════ */
  network(live) {
    const cranes = this.sorted(live.cranes.filter(c => !this.hiddenT.has(c.terminal)));
    const sig = "N" + JSON.stringify(cranes.map(c => [c.crane, c.state, c.enabled, c.live, (c.recent_intruders || []).join()]));
    const box = $("#mapBox");
    if (sig !== this.sceneSig || !$("#netSvg")) {
      this.sceneSig = sig; this.pkG = null; this.cranes = {};
      box.innerHTML = this.networkSvg(cranes, live);
      $$("#netSvg .node[data-c]").forEach(n => n.onclick = () => App.openCrane(n.dataset.c));
    }
    const w = live.writer || {};
    const tot = cranes.reduce((s, c) => s + (c.pkt_min || 0), 0);
    const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
    set("hubColTxt", live.collector.up ? `${tot} packets/min · ${cranes.filter(c => c.live).length} live` : "NOT RUNNING");
    set("hubColTxt2", live.collector.up ? `written ${App.num(w.written_total || 0)} since start` : "");
    set("hubInfTxt", w.healthy === false ? `buffering ${App.num(w.buffered)} points` : w.healthy ? "writes OK" : "waiting for data");
    set("hubInfTxt2", w.buffered ? `outage buffer ${App.num(w.buffered)}` : "outage buffer empty");
    cranes.forEach(c => set("pm_" + c.crane, c.state === "OFF" ? `OFF · ${c.pkt_min || 0}/min` : `${c.pkt_min || 0}/min · ${App.ago(c.last_packet)}`));
  },
  networkSvg(cranes, live) {
    const NW = 300, NH = 30, GAP = 5, X0 = 16, Y0 = 40;
    let y = Y0, curT = null, curLane = null;
    const pos = [], heads = [];
    cranes.forEach(c => {
      if (c.terminal !== curT) { if (curT !== null) y += 14; heads.push([y, `${c.terminal} · ${(App.meta.terminals[c.terminal] || {}).name || ""}`, true]); y += 22; curT = c.terminal; curLane = null; }
      if (c.crane[0] !== curLane) { heads.push([y, `Lane ${c.crane[0]}`, false]); y += 16; curLane = c.crane[0]; }
      pos.push([c, y]); y += NH + GAP;
    });
    const H = Math.max(y + 20, 420), hubY = Math.min(Math.max(H / 2, 200), 360);
    const WX = X0 + NW + 190, CX = WX + 230, IX = CX + 310, W = IX + 230;
    const col = c => this.col(c);
    const P = [`<svg id="netSvg" class="cty-net" xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><filter id="ng" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`];
    P.push(`<text x="${X0}" y="22" class="nt-h">CRANE PLCS · UDP</text>`);
    heads.forEach(([hy, t, big]) => P.push(`<text x="${X0}" y="${hy + 12}" class="${big ? "nt-t" : "nt-l"}">${h(t.toUpperCase())}</text>`));
    pos.forEach(([c, ny]) => {
      const sx = X0 + NW, sy = ny + NH / 2, d = `M${sx},${sy} C${sx + 110},${sy} ${WX - 110},${hubY} ${WX - 4},${hubY}`;
      const g = this.group(c);
      P.push(`<path d="${d}" fill="none" stroke="${c.live ? (c.enabled ? CT.cyan : CT.idle) : "#1e3a4c"}" stroke-width="${c.live ? 1.6 : 1}" ${c.enabled ? "" : 'stroke-dasharray="5 4"'} opacity="${c.live ? .8 : .5}"/>`);
      if (c.live) P.push(`<circle r="2.6" fill="#c9f6ff" filter="url(#ng)"><animateMotion dur="1.4s" repeatCount="indefinite" path="${d}"/></circle>`);
      (c.recent_intruders || []).forEach((ip, k) => {
        const iy = sy + 9 + k * 9, di = `M${sx},${iy} C${sx + 120},${iy} ${CX - 140},${hubY + 30} ${CX - 26},${hubY + 30}`;
        P.push(`<path d="${di}" fill="none" stroke="${CT.alarm}" stroke-width="1.6" stroke-dasharray="6 4"/><circle r="3" fill="${CT.alarm}" filter="url(#ng)"><animateMotion dur="1.6s" repeatCount="indefinite" path="${di}"/></circle>`);
        P.push(`<text x="${sx + 8}" y="${iy + 11}" class="nt-r">✕ ${h(ip)} blocked</text>`);
      });
    });
    if (cranes.some(c => (c.recent_intruders || []).length)) P.push(`<circle cx="${CX - 18}" cy="${hubY + 30}" r="9" fill="${CT.alarm}" filter="url(#ng)"/><text x="${CX - 22}" y="${hubY + 34}" class="nt-x">✕</text><text x="${CX - 130}" y="${hubY + 54}" class="nt-r">IP LOCK · NOT WRITTEN</text>`);
    const t1 = `M${WX + 120},${hubY} L${CX - 4},${hubY}`, t2 = `M${CX + 200},${hubY} L${IX - 4},${hubY}`;
    P.push(`<path d="${t1}" stroke="${CT.cyan}" stroke-width="5" opacity=".35" fill="none"/><path d="${t2}" stroke="${CT.ok}" stroke-width="5" opacity=".35" fill="none"/>`);
    if (cranes.some(c => c.live)) {
      for (let k = 0; k < 3; k++) P.push(`<circle r="3.4" fill="#c9f6ff" filter="url(#ng)"><animateMotion dur="1.2s" begin="${k * 0.4}s" repeatCount="indefinite" path="${t1}"/></circle>`);
      if ((live.writer || {}).healthy !== false) for (let k = 0; k < 2; k++) P.push(`<circle r="3.4" fill="#c9ffe6" filter="url(#ng)"><animateMotion dur="1.2s" begin="${k * 0.6}s" repeatCount="indefinite" path="${t2}"/></circle>`);
    }
    P.push(`<text x="${WX + 128}" y="${hubY - 10}" class="nt-l">PORT FORWARD → .237</text><text x="${CX + 208}" y="${hubY - 10}" class="nt-l">WRITE (HTTP)</text>`);
    const hub = (x, title, s1, s2, w, color) => `<g><rect x="${x}" y="${hubY - 38}" width="${w}" height="76" rx="4" fill="rgba(8,18,28,.92)" stroke="${color}" stroke-opacity=".7"/><rect x="${x}" y="${hubY - 38}" width="3" height="76" fill="${color}"/>
      <text x="${x + 14}" y="${hubY - 14}" class="nt-t">${title}</text><text x="${x + 14}" y="${hubY + 6}" class="nt-s" id="${s1}"></text><text x="${x + 14}" y="${hubY + 22}" class="nt-l" id="${s2}"></text></g>`;
    P.push(hub(WX, "WESTERMO", "hubWTxt", "hubWTxt2", 120, CT.ok));
    P.push(hub(CX, "COLLECTOR PC", "hubColTxt", "hubColTxt2", 200, live.collector.up ? CT.ok : CT.alarm));
    P.push(hub(IX, "NAS · INFLUXDB", "hubInfTxt", "hubInfTxt2", 200, (live.writer || {}).healthy === false ? CT.alarm : CT.ok));
    P.push(`<text x="${WX + 14}" y="${hubY + 6}" class="nt-s">router</text><text x="${WX + 14}" y="${hubY + 22}" class="nt-l">${cranes.length} CRANE PORTS</text>`);
    pos.forEach(([c, ny]) => {
      const cc = col(c);
      P.push(`<g class="node" data-c="${h(c.crane)}" style="cursor:pointer"><title>${h(c.crane)} · ${h(STATE_TEXT[c.state] || c.state)}</title>
        <rect x="${X0}" y="${ny}" width="${NW}" height="${NH}" rx="3" fill="rgba(8,18,28,.9)" stroke="${cc}" stroke-opacity="${this.group(c) === "idle" ? .35 : .8}" ${c.enabled ? "" : 'stroke-dasharray="4 3"'}/>
        <rect x="${X0}" y="${ny}" width="3" height="${NH}" fill="${CT.prog[c.program] || CT.idle}"/>
        <circle cx="${X0 + 14}" cy="${ny + NH / 2}" r="4" fill="${cc}" filter="url(#ng)"/>
        <text x="${X0 + 25}" y="${ny + 13}" class="nt-c">${h(c.crane)}</text>
        <text x="${X0 + 25}" y="${ny + 25}" class="nt-l">${c.port} · ${h(c.ip || "NO IP")} · ${h(App.verLabel(c))}</text>
        <text x="${X0 + NW - 6}" y="${ny + 13}" text-anchor="end" class="nt-l" id="pm_${h(c.crane)}"></text>
        <text x="${X0 + NW - 6}" y="${ny + 25}" text-anchor="end" class="nt-st" fill="${cc}">${h((STATE_SHORT[c.state] || c.state).toUpperCase())}</text></g>`);
    });
    if (!cranes.length) P.push(`<text x="${X0}" y="${Y0 + 20}" class="nt-s">No cranes registered - add them in Configuration.</text>`);
    P.push(`</svg>`);
    return P.join("");
  },

  /* ════════ replay ════════ */
  setupReplayBar() {
    const bar = $("#replayBar");
    if (!bar) return;
    bar.classList.toggle("hidden", this.mode !== "replay");
    if (this.mode !== "replay") return;
    const now = Date.now() / 1000;
    const cr = (App.live ? App.live.cranes : []).map(c => c.crane);
    bar.innerHTML = `<h4>Replay a past period on the yard</h4><div class="row">
      <label class="f">From (Dubai)<input type="datetime-local" id="rpFrom" value="${App.localInput(now - 3600)}"></label>
      <label class="f">To<input type="datetime-local" id="rpTo" value="${App.localInput(now)}"></label>
      <label class="f">Cranes (max 20)<select id="rpCranes" multiple size="3" style="min-width:160px">${cr.map(c => `<option selected>${c}</option>`).join("")}</select></label>
      <button class="cty-btn primary" id="rpLoad">Load replay</button><span class="grow"></span>
      <button class="cty-btn" id="rpPlay" disabled>▶ Play</button>
      <select id="rpSpeed"><option value="10">×10</option><option value="30" selected>×30</option><option value="60">×60</option><option value="180">×180</option></select></div>
      <div class="row" style="margin-top:8px"><input type="range" id="rpSlider" min="0" max="0" value="0" class="grow" disabled><b class="mono" id="rpTime" style="color:#9fe9ff"></b></div>`;
    $("#rpLoad").onclick = () => this.loadReplay();
    $("#rpPlay").onclick = () => this.togglePlay();
    $("#rpSlider").oninput = e => this.showReplay(+e.target.value);
  },
  async loadReplay() {
    const cranes = [...$("#rpCranes").selectedOptions].map(o => o.value).slice(0, 20);
    if (!cranes.length) return App.toast("Choose cranes");
    $("#mapBox").innerHTML = `<div class="cty-empty">Loading from InfluxDB…</div>`;
    try {
      const span = (new Date($("#rpTo").value) - new Date($("#rpFrom").value)) / 1000;
      const every = span > 6 * 3600 ? "30s" : span > 2 * 3600 ? "10s" : "5s";
      const d = await App.api("/api/replay", {json: {cranes, start: $("#rpFrom").value, stop: $("#rpTo").value, every}});
      const times = [...new Set(Object.values(d).flat().map(p => p[0]))].sort((a, b) => a - b);
      if (!times.length) { $("#mapBox").innerHTML = `<div class="cty-empty">No data for these cranes in this period.</div>`; return; }
      this.replay = {data: d, times, cranes, i: 0};
      const sl = $("#rpSlider"); sl.max = times.length - 1; sl.value = 0; sl.disabled = false;
      $("#rpPlay").disabled = false;
      this.sceneSig = null;
      this.showReplay(0);
    } catch (e) { $("#mapBox").innerHTML = `<div class="cty-empty">${h(e.message)}</div>`; }
  },
  showReplay(i) {
    const r = this.replay;
    if (!r) return;
    r.i = i;
    const t = r.times[i];
    $("#rpTime").textContent = App.fmtTime(t);
    $("#rpSlider").value = i;
    const cranes = r.cranes.map(c => {
      const pts = r.data[c] || [];
      let p = null;
      for (const q of pts) { if (q[0] <= t) p = q; else break; }
      const fresh = p && t - p[0] < 120;
      const reg = (App.live.cranes.find(x => x.crane === c) || {terminal: "T" + c[1]});
      return {crane: c, terminal: reg.terminal, program: reg.program, state: fresh ? "OK" : "IDLE", values: fresh ? {In_GANTRY1: p[1], In_TROLLEYPOMUX: p[2], In_HOIST: p[3], Step: p[4]} : {}};
    });
    this.yard(cranes, true);
  },
  togglePlay() {
    if (this.timer) return this.stopReplay(true);
    $("#rpPlay").textContent = "❚❚ Pause";
    this.timer = setInterval(() => {
      const r = this.replay;
      if (!r || r.i >= r.times.length - 1) return this.stopReplay(true);
      let j = r.i;
      const target = r.times[r.i] + +$("#rpSpeed").value * 0.5;
      while (j < r.times.length - 1 && r.times[j] < target) j++;
      this.showReplay(j);
    }, 500);
  },
  stopReplay(keep) {
    clearInterval(this.timer); this.timer = null;
    const b = $("#rpPlay"); if (b) b.textContent = "▶ Play";
    if (!keep) this.replay = null;
  },
};
App.views.map = MapView;
