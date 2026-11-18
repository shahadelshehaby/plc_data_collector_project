/* Live Map: Network view (data path PLC -> Westermo -> Collector -> InfluxDB),
   Yard view (each lane a rail, cranes at their live gantry position) and Replay. */
"use strict";
const SVGNS = "http://www.w3.org/2000/svg";
const MapView = {
  mode: localStorage.getItem("cdm.mapmode") || "network",
  sig: null, lastPos: {}, replay: null, timer: null,

  render(el) {
    el.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <h2 style="margin:0">Live Map</h2>
        <div class="seg" id="mapMode">${[["network", "Network / data path"], ["yard", "Yard"], ["replay", "Replay"]].map(([k, t]) => `<button data-m="${k}" class="${this.mode === k ? "on" : ""}">${t}</button>`).join("")}</div>
        <span class="right legend">
          <span><i class="dot ok"></i>OK - data flowing</span><span><i class="dot"></i>Idle / no data</span>
          <span><i class="dot attn"></i>Warning</span><span><i class="dot err"></i>Alarm</span><span>- - - writing OFF</span></span>
      </div>
      <div id="replayBar" class="card hidden" style="margin-bottom:10px"></div>
      <div class="mapwrap" id="mapBox" style="min-height:420px"></div>
      <div class="small muted" style="margin-top:6px">Click any crane for its status, port, IP, live values and actions. Moving dots = packets arriving (one per ~1.2 s).</div>`;
    $$("#mapMode button").forEach(b => b.onclick = () => {
      this.mode = b.dataset.m; localStorage.setItem("cdm.mapmode", this.mode);
      $$("#mapMode button").forEach(x => x.classList.toggle("on", x === b));
      this.sig = null; this.stopReplay(false);
      this.setupReplayBar();
      this.update(App.live);
    });
    this.sig = null;
    this.setupReplayBar();
  },

  update(live) {
    if (!$("#mapBox") || !live) return;
    if (this.mode === "network") this.network(live);
    else if (this.mode === "yard") this.yard(live.cranes, false);
    else if (this.mode === "replay" && !this.replay) $("#mapBox").innerHTML = `<div class="empty">Choose a time range and cranes above, then <b>Load replay</b>.</div>`;
  },

  stateGroup(c) { return ALARM_STATES.includes(c.state) ? "alarm" : WARN_STATES.includes(c.state) ? "warn" : c.state; },
  color(c) {
    const g = this.stateGroup(c);
    return g === "alarm" ? "var(--dot-err)" : g === "warn" ? "var(--dot-attn)" : g === "OK" ? "var(--dot-ok)" : "var(--dot-off)";
  },
  sorted(cranes) {
    return [...cranes].sort((a, b) => (a.terminal + a.crane[0] + a.crane.slice(2)).localeCompare(b.terminal + b.crane[0] + b.crane.slice(2)));
  },

  /* ── network view ── */
  network(live) {
    const cranes = this.sorted(live.cranes);
    const sig = JSON.stringify(cranes.map(c => [c.crane, c.state, c.enabled, c.live, (c.recent_intruders || []).join()]));
    const box = $("#mapBox");
    if (sig !== this.sig || !$("#netSvg")) {
      this.sig = sig;
      box.innerHTML = this.networkSvg(cranes, live);
      $$("#netSvg .node[data-c]").forEach(n => n.onclick = () => App.openCrane(n.dataset.c));
      $("#hubCollector") && ($("#hubCollector").onclick = () => location.hash = "#config/collector");
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
    const NW = 250, NH = 30, GAP = 5, X0 = 16, Y0 = 40;
    let y = Y0;
    const pos = [];
    let curT = null, curLane = null;
    const heads = [];
    cranes.forEach(c => {
      if (c.terminal !== curT) { if (curT !== null) y += 14; heads.push([y, `${c.terminal} · ${(App.meta.terminals[c.terminal] || {}).name || ""}`, true]); y += 22; curT = c.terminal; curLane = null; }
      if (c.crane[0] !== curLane) { heads.push([y, `Lane ${c.crane[0]}`, false]); y += 16; curLane = c.crane[0]; }
      pos.push([c, y]); y += NH + GAP;
    });
    const H = Math.max(y + 20, 420);
    const hubY = Math.min(Math.max(H / 2, 200), 360);
    const WX = X0 + NW + 190, CX = WX + 230, IX = CX + 270, W = IX + 230;
    const P = [];
    P.push(`<svg id="netSvg" xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
    P.push(`<text x="${X0}" y="22" font-size="13" font-weight="600">Crane PLCs (UDP)</text>`);
    heads.forEach(([hy, t, big]) => P.push(`<text x="${X0}" y="${hy + 12}" font-size="${big ? 13 : 11}" ${big ? 'font-weight="700"' : 'class="lbl2"'}>${h(t)}</text>`));
    // links
    pos.forEach(([c, ny]) => {
      const sx = X0 + NW, sy = ny + NH / 2;
      const d = `M${sx},${sy} C${sx + 110},${sy} ${WX - 110},${hubY} ${WX - 4},${hubY}`;
      const g = this.stateGroup(c);
      P.push(`<path class="link ${c.live ? "OK" : ""} ${g === "alarm" ? "alarm" : ""} ${c.enabled ? "" : "OFF"}" d="${d}" id="lk_${c.crane}"/>`);
      if (c.live) P.push(`<circle r="3.6" fill="${c.enabled ? "var(--dot-ok)" : "var(--dot-off)"}"><animateMotion dur="1.4s" repeatCount="indefinite" path="${d}"/></circle>`);
      (c.recent_intruders || []).forEach((ip, k) => {
        const iy = sy + 9 + k * 9;
        const di = `M${sx},${iy} C${sx + 120},${iy} ${CX - 140},${hubY + 30} ${CX - 26},${hubY + 30}`;
        P.push(`<path class="intruder" d="${di}"/><circle r="3.4" fill="var(--dot-err)"><animateMotion dur="1.6s" repeatCount="indefinite" path="${di}"/></circle>`);
        P.push(`<text x="${sx + 8}" y="${iy + 11}" font-size="10" fill="var(--danger)" style="fill:var(--danger)">✕ ${h(ip)} blocked</text>`);
      });
    });
    const anyIntr = cranes.some(c => (c.recent_intruders || []).length);
    if (anyIntr) P.push(`<g><circle cx="${CX - 18}" cy="${hubY + 30}" r="9" fill="var(--dot-err)"/><text x="${CX - 22}" y="${hubY + 34}" font-size="12" style="fill:#fff" font-weight="700">✕</text><text x="${CX - 120}" y="${hubY + 52}" font-size="10" style="fill:var(--danger)">IP lock: not written</text></g>`);
    // trunks
    const t1 = `M${WX + 120},${hubY} L${CX - 4},${hubY}`, t2 = `M${CX + 150},${hubY} L${IX - 4},${hubY}`;
    const anyLive = cranes.some(c => c.live);
    P.push(`<path class="trunk" d="${t1}"/><path class="trunk" d="${t2}"/>`);
    if (anyLive) {
      for (let k = 0; k < 3; k++) P.push(`<circle r="4" fill="var(--accent)"><animateMotion dur="1.2s" begin="${k * 0.4}s" repeatCount="indefinite" path="${t1}"/></circle>`);
      if ((live.writer || {}).healthy !== false) for (let k = 0; k < 2; k++) P.push(`<circle r="4" fill="var(--accent)"><animateMotion dur="1.2s" begin="${k * 0.6}s" repeatCount="indefinite" path="${t2}"/></circle>`);
    }
    P.push(`<text x="${WX + 128}" y="${hubY - 10}" class="lbl2">port forward → .237</text>`);
    P.push(`<text x="${CX + 158}" y="${hubY - 10}" class="lbl2">write (HTTP)</text>`);
    // hubs
    const hub = (x, title, sub1id, sub2id, w, icon, extraId, bad) => `<g class="hub node" ${extraId ? `id="${extraId}"` : ""}><rect x="${x}" y="${hubY - 38}" width="${w}" height="76" rx="10" style="${bad ? "stroke:var(--dot-err);stroke-width:3" : ""}"/>
      <text x="${x + 12}" y="${hubY - 14}" font-size="13" font-weight="700">${icon} ${title}</text>
      <text x="${x + 12}" y="${hubY + 6}" font-size="11" id="${sub1id}"></text><text x="${x + 12}" y="${hubY + 22}" font-size="10.5" class="lbl2" id="${sub2id}"></text></g>`;
    P.push(hub(WX, "Westermo", "hubWTxt", "hubWTxt2", 120, "⇄"));
    P.push(hub(CX, "Collector PC", "hubColTxt", "hubColTxt2", 150, "▣", "hubCollector", !live.collector.up));
    P.push(hub(IX, "InfluxDB (NAS)", "hubInfTxt", "hubInfTxt2", 200, "⛁", null, (live.writer || {}).healthy === false));
    P.push(`<text x="${WX + 12}" y="${hubY + 6}" font-size="11">router</text><text x="${WX + 12}" y="${hubY + 22}" class="lbl2" font-size="10.5">${cranes.length} crane ports</text>`);
    P.push(`<text x="${IX + 12}" y="${hubY + 52}" class="lbl2" font-size="10.5">${h(App.meta.influx_bucket)} · tag crane_id</text>`);
    // crane nodes
    pos.forEach(([c, ny]) => {
      const g = this.stateGroup(c);
      P.push(`<g class="node st-${g}" data-c="${h(c.crane)}"><title>${h(c.crane)} · ${h(STATE_TEXT[c.state] || c.state)} · port ${c.port} · ${h(c.ip || "no IP")}</title>
        <rect class="box" x="${X0}" y="${ny}" width="${NW}" height="${NH}" rx="6"/>
        <circle cx="${X0 + 12}" cy="${ny + NH / 2}" r="5" fill="${this.color(c)}"/>
        <text x="${X0 + 24}" y="${ny + 13}" font-size="12.5" font-weight="700">${h(c.crane)}</text>
        <text x="${X0 + 24}" y="${ny + 25}" class="lbl2">${c.port} · ${h(c.ip || "no IP")} · ${h(c.version || "")}</text>
        <text x="${X0 + NW - 6}" y="${ny + 13}" font-size="10" text-anchor="end" class="lbl2" id="pm_${h(c.crane)}"></text>
        <text x="${X0 + NW - 6}" y="${ny + 25}" font-size="10" font-weight="600" text-anchor="end" style="fill:${this.color(c)}">${h(STATE_SHORT[c.state] || c.state)}</text></g>`);
    });
    if (!cranes.length) P.push(`<text x="${X0}" y="${Y0 + 20}" class="lbl2" font-size="13">No cranes registered${App.terminal ? " in " + App.terminal : ""} - add them in Configuration.</text>`);
    P.push(`</svg>`);
    return P.join("");
  },

  /* ── yard view ── */
  yard(cranes, isReplay, replayT) {
    const box = $("#mapBox");
    const yd = App.meta.yard;
    const list = this.sorted(cranes);
    const sig = (isReplay ? "R" : "L") + JSON.stringify(list.map(c => [c.crane, c.terminal]));
    const terms = {};
    list.forEach(c => { (terms[c.terminal] = terms[c.terminal] || {}); (terms[c.terminal][c.crane[0]] = terms[c.terminal][c.crane[0]] || []).push(c); });
    let gmax = yd.gantry_max, gmin = yd.gantry_min;
    list.forEach(c => { const g = (c.values || {}).In_GANTRY1; if (typeof g === "number" && g > gmax) gmax = Math.ceil(g / 100) * 100 + 100; });
    const LX = 60, W = Math.max(900, box.clientWidth - 30), RW = W - LX - 40, LH = 112;
    const gx = g => LX + (Math.min(Math.max(g, gmin), gmax) - gmin) / (gmax - gmin) * RW;
    if (sig !== this.sig || !$("#yardSvg")) {
      this.sig = sig;
      const P = [];
      let y = 10;
      const rows = [];
      Object.keys(terms).sort().forEach(t => {
        rows.push(["T", t, y]); y += 40;
        Object.keys(terms[t]).sort().forEach(lane => { rows.push(["L", lane, y, t]); y += LH; });
        y += 10;
      });
      const H = Math.max(y + 20, 200);
      P.push(`<svg id="yardSvg" xmlns="${SVGNS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
      rows.forEach(r => {
        if (r[0] === "T") { P.push(`<text x="10" y="${r[2] + 18}" font-size="14" font-weight="700">${h(r[1])} · ${h((App.meta.terminals[r[1]] || {}).name || "")}</text>`); return; }
        const ry = r[2] + 62;
        P.push(`<text x="14" y="${ry - 20}" font-size="20" font-weight="700" style="fill:var(--text2)">${h(r[1])}</text>`);
        P.push(`<line class="lane-rail" x1="${LX}" y1="${ry}" x2="${LX + RW}" y2="${ry}"/><line class="lane-rail" x1="${LX}" y1="${ry + 5}" x2="${LX + RW}" y2="${ry + 5}" style="stroke-width:1.5"/>`);
        for (let g = Math.ceil(gmin / 250) * 250; g <= gmax; g += 250) P.push(`<line x1="${gx(g)}" y1="${ry + 5}" x2="${gx(g)}" y2="${ry + 10}" style="stroke:var(--rail)"/><text x="${gx(g)}" y="${ry + 20}" class="lbl2" text-anchor="middle" font-size="9">${g}</text>`);
        terms[r[3]][r[1]].forEach(c => {
          P.push(`<g class="yard-crane" id="yc_${h(c.crane)}" data-c="${h(c.crane)}" style="transform:translate(${LX}px,${ry - 46}px)">
            <title>${h(c.crane)}</title>
            <line class="frame" x1="0" y1="0" x2="0" y2="46"/><line class="frame" x1="30" y1="0" x2="30" y2="46"/><line class="frame" x1="-5" y1="0" x2="35" y2="0" style="stroke-width:3.5"/>
            <rect class="yard-trolley" x="-3" y="-5" width="7" height="6" rx="1"/>
            <line class="yard-hoist" x1="0" y1="1" x2="0" y2="20"/>
            <rect class="yard-spreader" x="-6" y="20" width="13" height="3" rx="1"/>
            <circle class="ystate" cx="15" cy="-12" r="4"/>
            <text x="15" y="-19" font-size="10.5" font-weight="700" text-anchor="middle">${h(c.crane)}</text>
            <text class="ytxt lbl2" x="15" y="80" font-size="9.5" text-anchor="middle"></text></g>`);
        });
      });
      if (!list.length) P.push(`<text x="20" y="40" class="lbl2" font-size="13">No cranes registered${App.terminal ? " in " + App.terminal : ""}.</text>`);
      P.push(`<text x="${LX + RW}" y="${H - 6}" class="lbl2" text-anchor="end" font-size="10">gantry position (m) · trolley and hoist drawn on each crane · ${isReplay ? "replay" : "live"}</text></svg>`);
      box.innerHTML = P.join("");
      $$("#yardSvg .yard-crane").forEach(n => n.onclick = () => App.openCrane(n.dataset.c));
    }
    const parked = {};
    list.forEach(c => {
      const g = document.getElementById("yc_" + c.crane);
      if (!g) return;
      const v = c.values || {};
      const ry = parseFloat(g.style.transform.split(",")[1]);
      let gp = v.In_GANTRY1 ?? v.In_GANTRY2;
      if (typeof gp === "number") this.lastPos[c.crane] = gp; else gp = this.lastPos[c.crane];
      const lk = c.terminal + c.crane[0];
      const x = typeof gp === "number" ? gx(gp) - 15 : LX + 6 + 66 * (parked[lk] = (parked[lk] ?? -1) + 1);
      g.style.transform = `translate(${x}px,${ry}px)`;
      g.setAttribute("class", "yard-crane st-" + this.stateGroup(c));
      const tp = typeof v.In_TROLLEYPOMUX === "number" ? Math.min(Math.max(v.In_TROLLEYPOMUX / yd.trolley_max, 0), 1) : 0.5;
      const hp = typeof v.In_HOIST === "number" ? Math.min(Math.max(v.In_HOIST / yd.hoist_max, 0), 1) : 1;
      const tx = tp * 30;
      $(".yard-trolley", g).setAttribute("x", tx - 3.5);
      const sy = 4 + (1 - hp) * 36;
      const hl = $(".yard-hoist", g); hl.setAttribute("x1", tx); hl.setAttribute("x2", tx); hl.setAttribute("y2", sy);
      const sp = $(".yard-spreader", g); sp.setAttribute("x", tx - 6.5); sp.setAttribute("y", sy);
      sp.style.fill = v.TwistlockLocked ? "var(--chart-red)" : "var(--chart-amber)";
      $(".ystate", g).setAttribute("fill", this.color(c));
      const sz = v.Spreader45ft ? "45ft" : v.Spreader40ft ? "40ft" : v.Spreader20ft ? "20ft" : "";
      $(".ytxt", g).textContent = isReplay ? (typeof gp === "number" ? `${gp.toFixed(0)} m · step ${v.Step ?? "–"}` : "no data") :
        (typeof gp === "number" ? `${gp.toFixed(0)} m ${sz}` + (c.state !== "OK" ? " · " + (STATE_SHORT[c.state] || c.state) : "") : (STATE_SHORT[c.state] || c.state) + ", no pos.");
    });
  },

  /* ── replay ── */
  setupReplayBar() {
    const bar = $("#replayBar");
    if (!bar) return;
    bar.classList.toggle("hidden", this.mode !== "replay");
    if (this.mode !== "replay") return;
    const now = Date.now() / 1000;
    const cr = (App.live ? App.live.cranes : []).map(c => c.crane);
    bar.innerHTML = `<div class="row">
      <label class="f">From (Dubai)<input type="datetime-local" id="rpFrom" value="${App.localInput(now - 3600)}"></label>
      <label class="f">To<input type="datetime-local" id="rpTo" value="${App.localInput(now)}"></label>
      <label class="f">Cranes (max 20)<select id="rpCranes" multiple size="3" style="min-width:160px">${cr.map(c => `<option selected>${c}</option>`).join("")}</select></label>
      <button class="btn primary" id="rpLoad">Load replay</button>
      <span class="grow"></span>
      <button class="btn" id="rpPlay" disabled>▶ Play</button>
      <select id="rpSpeed"><option value="10">×10</option><option value="30" selected>×30</option><option value="60">×60</option><option value="180">×180</option></select>
      </div><div class="row" style="margin-top:8px"><input type="range" id="rpSlider" min="0" max="0" value="0" class="grow" disabled><b class="mono" id="rpTime"></b></div>`;
    $("#rpLoad").onclick = () => this.loadReplay();
    $("#rpPlay").onclick = () => this.togglePlay();
    $("#rpSlider").oninput = e => this.showReplay(+e.target.value);
  },
  async loadReplay() {
    const cranes = [...$("#rpCranes").selectedOptions].map(o => o.value).slice(0, 20);
    if (!cranes.length) return App.toast("Choose cranes");
    $("#mapBox").innerHTML = `<div class="empty">Loading from InfluxDB…</div>`;
    try {
      const span = (new Date($("#rpTo").value) - new Date($("#rpFrom").value)) / 1000;
      const every = span > 6 * 3600 ? "30s" : span > 2 * 3600 ? "10s" : "5s";
      const d = await App.api("/api/replay", {json: {cranes, start: $("#rpFrom").value, stop: $("#rpTo").value, every}});
      const times = [...new Set(Object.values(d).flat().map(p => p[0]))].sort((a, b) => a - b);
      if (!times.length) { $("#mapBox").innerHTML = `<div class="empty">No data for these cranes in this period.</div>`; return; }
      this.replay = {data: d, times, cranes, i: 0};
      const sl = $("#rpSlider"); sl.max = times.length - 1; sl.value = 0; sl.disabled = false;
      $("#rpPlay").disabled = false;
      this.sig = null;
      this.showReplay(0);
    } catch (e) { $("#mapBox").innerHTML = `<div class="empty">${h(e.message)}</div>`; }
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
      return {crane: c, terminal: reg.terminal, state: fresh ? "OK" : "IDLE", values: fresh ? {In_GANTRY1: p[1], In_TROLLEYPOMUX: p[2], In_HOIST: p[3], Step: p[4]} : {}};
    });
    this.yard(cranes, true, t);
  },
  togglePlay() {
    if (this.timer) return this.stopReplay(true);
    $("#rpPlay").textContent = "❚❚ Pause";
    const step = () => {
      const r = this.replay;
      if (!r || r.i >= r.times.length - 1) return this.stopReplay(true);
      const speed = +$("#rpSpeed").value;
      let j = r.i, target = r.times[r.i] + speed * 0.5;
      while (j < r.times.length - 1 && r.times[j] < target) j++;
      this.showReplay(j);
    };
    this.timer = setInterval(step, 500);
  },
  stopReplay(keep) {
    clearInterval(this.timer); this.timer = null;
    const b = $("#rpPlay"); if (b) b.textContent = "▶ Play";
    if (!keep) this.replay = null;
  },
};
App.views.map = MapView;
