/* Crane Data Manager - core: state, live polling, router, dialogs, crane panel,
   Live Status, Alarms & Events, Dashboard. No external libraries (works offline). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const ALARM_STATES = ["IP_CONFLICT", "WRONG_SIZE", "PARSE_ERROR", "PORT_BUSY", "DOWN"];
const WARN_STATES = ["BUFFERING", "MISSING_IP", "NO_VERSION", "NOT_LOADED"];
const STATE_TEXT = {
  OK: "OK", IDLE: "Idle / no data", OFF: "OFF (listening, not writing)", IP_CONFLICT: "IP conflict",
  WRONG_SIZE: "Wrong size", PARSE_ERROR: "Parse error", PORT_BUSY: "Port busy", BUFFERING: "Buffering",
  MISSING_IP: "Missing IP", NO_VERSION: "No version", NOT_LOADED: "Waiting for refresh", DOWN: "Collector down",
};
const STATE_HELP = {
  OK: "Packets arriving from the registered IP and written to InfluxDB",
  IDLE: "No packet for a few seconds - normal when the crane is not in Auto with an active work order",
  OFF: "Writing switched off in the platform. The port is still listened to, nothing is written",
  IP_CONFLICT: "Another IP is sending to this crane's port. Those packets are blocked; the crane itself is still collected",
  WRONG_SIZE: "Packet size does not match the crane's version",
  PARSE_ERROR: "A packet could not be decoded",
  PORT_BUSY: "The UDP port is used by another program (old collector?) - retrying every 10 s",
  BUFFERING: "InfluxDB cannot be reached - data is kept in the outage buffer and sent later",
  MISSING_IP: "No registered IP - nothing is written until an IP is entered",
  NO_VERSION: "No packet version assigned", NOT_LOADED: "Saved but not yet loaded by the collector",
  DOWN: "The collector service does not answer",
};
const STATE_SHORT = {OK: "OK", IDLE: "Idle", OFF: "OFF", IP_CONFLICT: "IP conflict", WRONG_SIZE: "Wrong size", PARSE_ERROR: "Parse error",
  PORT_BUSY: "Port busy", BUFFERING: "Buffering", MISSING_IP: "Missing IP", NO_VERSION: "No version", NOT_LOADED: "Not loaded", DOWN: "Down"};
const stateClass = s => ALARM_STATES.includes(s) ? "alarm" : WARN_STATES.includes(s) ? "warn" : s;
const badge = (s, txt) => `<span class="badge ${h(s)}" title="${h(STATE_HELP[s] || "")}">${h(txt || STATE_TEXT[s] || s)}</span>`;

const App = {
  meta: null, live: null, view: null, views: {},
  terminal: localStorage.getItem("cdm.terminal") || "",
  seenAlarms: null, muted: localStorage.getItem("cdm.muted") === "1",
  drawerCrane: null, drawerTimer: null, liveListeners: [],

  async api(path, opts = {}) {
    const o = {headers: {}, ...opts};
    if (o.json !== undefined) { o.method = o.method || "POST"; o.body = JSON.stringify(o.json); o.headers["Content-Type"] = "application/json"; delete o.json; }
    const r = await fetch(path, o);
    const ct = r.headers.get("content-type") || "";
    const data = ct.includes("json") ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || r.statusText);
    return data;
  },

  async start() {
    this.meta = await this.api("/api/meta");
    $("#mute").textContent = this.muted ? "🔇" : "🔊";
    $("#mute").onclick = () => { this.muted = !this.muted; localStorage.setItem("cdm.muted", this.muted ? "1" : "0"); $("#mute").textContent = this.muted ? "🔇" : "🔊"; if (!this.muted) this.beep(1); };
    $("#bell").onclick = () => location.hash = "#alarms";
    window.addEventListener("hashchange", () => this.route());
    setInterval(() => $("#clock").textContent = this.fmtTime(Date.now() / 1000, true) + " Dubai", 1000);
    this.renderTerms();
    await this.poll();
    setInterval(() => this.poll(), 1500);
    this.route();
  },

  renderTerms() {
    const t = $("#terms");
    const tc = (this.live && this.live.terminal_counts) || {};
    const items = [["", "All"]].concat(Object.keys(this.meta.terminals).map(k => [k, k]));
    t.innerHTML = items.map(([k, label]) => {
      const c = k ? tc[k] : null;
      const cnt = c ? `<span class="cnt">${c.ok}/${c.registered}${c.alarm ? ` <b>●${c.alarm}</b>` : ""}</span>` : "";
      return `<button data-t="${k}" class="${this.terminal === k ? "on" : ""}" title="${k ? this.meta.terminals[k].name : "All terminals"}">${label}${cnt}</button>`;
    }).join("");
    $$("button", t).forEach(b => b.onclick = () => {
      this.terminal = b.dataset.t; localStorage.setItem("cdm.terminal", this.terminal);
      this.renderTerms(); this.route(true);
    });
  },

  route(force) {
    const v = (location.hash || "#map").slice(1).split("/")[0] || "map";
    $$("#tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
    if (v !== this.view || force || location.hash !== this.hash) {
      this.view = v;
      this.hash = location.hash;
      const el = $("#view");
      el.innerHTML = "";
      this.liveListeners = [];
      const view = this.views[v] || this.views.map;
      view.render(el, (location.hash.split("/")[1] || ""));
      if (this.live && view.update) view.update(this.live);
    }
  },

  onLive(fn) { this.liveListeners.push(fn); },

  async poll() {
    try {
      const live = await this.api("/api/live" + (this.terminal ? "?terminal=" + this.terminal : ""));
      this.live = live;
      this.applyLive(live);
    } catch (e) {
      $("#bannerDown").classList.remove("hidden");
      $("#bannerDown").innerHTML = `⚠ The platform does not answer (${h(e.message)}). If the collector service is running it keeps collecting.`;
    }
  },

  applyLive(live) {
    const c = live.collector, w = live.writer;
    const pc = $("#pillCollector");
    pc.innerHTML = `<span class="dot ${c.up ? "ok" : "err pulse"}"></span>Collector ${c.up ? "running" : "DOWN"}`;
    pc.title = c.up ? `pid ${c.pid}, since ${this.fmtTime(c.started)}` : c.error;
    const pi = $("#pillInflux");
    const ih = w ? w.healthy : null;
    pi.innerHTML = `<span class="dot ${ih === true ? "ok" : ih === false ? "err pulse" : ""}"></span>InfluxDB ${ih === true ? "OK" : ih === false ? "buffering " + (w.buffered || 0) : "–"}`;
    pi.title = w ? (w.last_error || `written ${w.written_total}`) : "";
    const down = $("#bannerDown");
    down.classList.toggle("hidden", c.up);
    if (!c.up) down.innerHTML = `⚠ <b>Collector service is not responding</b> - no data is being collected. The platform is trying to restart it. <a style="color:#fff" href="#config/collector">Details</a>`;
    // alarms
    const un = live.alarms.filter(a => !a.acked);
    $("#bellN").textContent = live.alarms.length;
    $("#bellN").classList.toggle("hidden", !live.alarms.length);
    const ba = $("#bannerAlarm");
    ba.classList.toggle("hidden", !un.length);
    if (un.length) {
      const a = un[0];
      ba.innerHTML = `⚠ <b>${un.length} active alarm${un.length > 1 ? "s" : ""}</b> &nbsp; ${h(a.crane || "")} ${h(a.type.replace(/_/g, " "))}: ${h(a.message.slice(0, 140))}${a.message.length > 140 ? "…" : ""} <span class="right"></span><button class="btn sm" onclick="location.hash='#alarms'">View</button><button class="btn sm" id="ackAllBtn">Acknowledge all</button>`;
      $("#ackAllBtn").onclick = () => this.ackAll();
    }
    const ids = new Set(live.alarms.map(a => a.id));
    if (this.seenAlarms) {
      const fresh = live.alarms.filter(a => !this.seenAlarms.has(a.id) && !a.acked);
      if (fresh.length && this.meta.sound !== false) this.beep(3);
    }
    this.seenAlarms = ids;
    const bp = $("#bannerPending");
    bp.classList.toggle("hidden", !(live.pending.length && c.up));
    if (live.pending.length && c.up) {
      bp.innerHTML = `⟳ The collector has not loaded the latest settings for: <b>${h(live.pending.join(", "))}</b> <button class="btn sm" id="pendRefresh">Refresh collector</button>`;
      $("#pendRefresh").onclick = () => Config.refreshCollector();
    }
    this.renderTerms();
    const view = this.views[this.view];
    if (view && view.update) try { view.update(live); } catch (e) { console.error(e); }
    this.liveListeners.forEach(fn => { try { fn(live); } catch (e) { console.error(e); } });
  },

  async ackAll() {
    const note = prompt("Acknowledge all active alarms. Note (optional):", "");
    if (note === null) return;
    await this.api("/api/alarms/ack_all", {json: {note}});
    this.poll();
  },

  beep(times = 1) {
    if (this.muted) return;
    try {
      const ctx = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
      for (let i = 0; i < times; i++) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square"; o.frequency.value = i % 2 ? 660 : 880;
        g.gain.value = 0.06;
        o.connect(g); g.connect(ctx.destination);
        const t = ctx.currentTime + i * 0.28;
        o.start(t); o.stop(t + 0.18);
      }
    } catch (e) { /* audio blocked until the first click */ }
  },

  // ── formatting ──
  fmtTime(ts, withSec = true, withDate = true) {
    if (!ts) return "";
    const d = new Date(ts * 1000 + 4 * 3600 * 1000);
    const p = n => String(n).padStart(2, "0");
    const t = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${withSec ? ":" + p(d.getUTCSeconds()) : ""}`;
    return withDate ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${t}` : t;
  },
  ago(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Date.now() / 1000 - ts);
    if (s < 60) return Math.round(s) + "s ago";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return (s / 3600).toFixed(1) + " h ago";
    return Math.round(s / 86400) + " d ago";
  },
  num(v, d = 2) {
    if (v === null || v === undefined || v === "") return "–";
    if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(d);
    return v;
  },
  localInput(ts) {   // Dubai time for <input type=datetime-local>
    const d = new Date(ts * 1000 + 4 * 3600 * 1000);
    return d.toISOString().slice(0, 16);
  },
  today() { return this.localInput(Date.now() / 1000).slice(0, 10); },

  toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.innerHTML = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.remove(), kind === "err" ? 9000 : 5000);
  },
  err(e) { this.toast("⚠ " + h(e.message || e), "err"); },
  applied(r) {
    if (!r) return;
    if (r.applied === false) this.toast("Saved. " + h(r.note || ""), "");
    else if (r.changes && r.changes.length) this.toast("Applied to the collector: " + h(r.changes.join("; ")), "ok");
    else this.toast("Saved and applied", "ok");
  },

  // ── dialogs ──
  modal({title, html, wide, danger, onClose}) {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal ${wide ? "wide" : ""} ${danger ? "danger" : ""}"><h2>${title}</h2><div class="mbody">${html}</div></div>`;
    document.body.appendChild(bg);
    const close = () => { bg.remove(); onClose && onClose(); };
    bg.addEventListener("mousedown", e => { if (e.target === bg) close(); });
    const esc = e => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", esc); } };
    document.addEventListener("keydown", esc);
    return {el: $(".modal", bg), close};
  },

  /* Safety confirmation for every critical action: shows exactly what will
     change, requires a reason, and for stop / bulk actions a typed word. */
  confirm({title, summary, danger = false, typed = null, okText = "Confirm", reasonHint = ""}) {
    return new Promise(resolve => {
      const m = this.modal({title: (danger ? "⚠ " : "") + title, danger, html: `
        <div class="confirm-box">${summary}</div>
        <label class="f">Reason (saved in the change log)<textarea id="cfReason" placeholder="${h(reasonHint || "e.g. crane in maintenance / new PLC version installed")}"></textarea></label>
        ${typed ? `<label class="f" style="margin-top:8px"><span>Type <b class="mono" style="color:var(--text)">${h(typed)}</b> to confirm</span><input id="cfTyped" autocomplete="off"></label>` : ""}
        <div class="actions"><button class="btn" id="cfNo">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" id="cfYes" disabled>${h(okText)}</button></div>`,
        onClose: () => resolve(null)});
      const yes = $("#cfYes", m.el), r = $("#cfReason", m.el), t = $("#cfTyped", m.el);
      const check = () => yes.disabled = !(r.value.trim().length >= 3 && (!typed || (t.value.trim().toUpperCase() === typed.toUpperCase())));
      r.oninput = check; if (t) t.oninput = check;
      r.focus();
      $("#cfNo", m.el).onclick = () => m.close();
      yes.onclick = () => { resolve({reason: r.value.trim(), confirm_text: t ? t.value.trim() : ""}); m.close(); };
    });
  },

  // ── crane side panel ──
  async openCrane(crane) {
    this.drawerCrane = crane;
    const d = $("#drawer");
    d.classList.add("open");
    d.innerHTML = `<div class="hd"><b style="font-size:18px">${h(crane)}</b><span class="right"></span><button class="btn sm" id="drClose">✕</button></div><div class="bd"><div class="empty">Loading…</div></div>`;
    $("#drClose").onclick = () => this.closeCrane();
    clearInterval(this.drawerTimer);
    await this.refreshCrane(true);
    this.drawerTimer = setInterval(() => this.refreshCrane(false), 2000);
  },
  closeCrane() {
    clearInterval(this.drawerTimer);
    this.drawerCrane = null;
    $("#drawer").classList.remove("open");
  },
  async refreshCrane(first) {
    const crane = this.drawerCrane;
    if (!crane) return;
    let d;
    try { d = await this.api("/api/crane/" + crane); } catch (e) { return; }
    if (crane !== this.drawerCrane) return;
    const c = d.config, L = d.live || {}, v = L.values || {};
    const st = L.state || (d.collector_error ? "DOWN" : "NOT_LOADED");
    const intr = Object.entries(L.intruders || {});
    const today = d.today || {};
    const dr = L.drift != null ? Math.round(L.drift) : null;
    const drift = dr != null ? `${dr > 0 ? "+" : ""}${dr === 0 ? 0 : dr} s (PLC clock in ${L.drift_mode} time)` : "–";
    const vals = [
      ["Control state", v.ControlState], ["Auto", v.AutoActive], ["Work order", v.WorkorderIdent],
      ["Move type", v.MoveType], ["Step", v.Step], ["Step info", v.StepInfo],
      ["Container", v.ContainerID], ["PLC time", v.PLCTime],
      ["Gantry pos", v.In_GANTRY1], ["Gantry speed %", v.GANTRYSPEED1], ["Trolley pos", v.In_TROLLEYPOMUX],
      ["Trolley speed %", v.TROLLEYSPEED1], ["Hoist pos", v.In_HOIST], ["Hoist speed %", v.HOISTSPEED1],
      ["Gantry ref", v.GantryRef], ["Trolley ref", v.TrolleyRef], ["Hoist ref", v.HoistRef],
      ["Load (sum LC)", v.LoadTotal], ["Gantry current", v.In_GANTRYCurrent1], ["Hoist current", v.In_HOISTCurrent1],
      ["Trolley current", v.In_TROLLEYCurrent1],
      ["Spreader", v.Spreader45ft ? "45 ft" : v.Spreader40ft ? "40 ft" : v.Spreader20ft ? "20 ft" : "–"],
      ["Twin mode", v.TwinMode], ["Twistlocks", v.TwistlockLocked ? "locked" : v.TwistlockUnlocked ? "unlocked" : "–"],
      ["Landed", v.LandedAllPins], ["Manual interv.", v.ManualIntervention], ["Fwd crane gantry", v.FwdCraneGantry],
      ["Bwd crane gantry", v.BwdCraneGantry],
    ].filter(x => x[1] !== undefined);
    const body = `
      <div class="row">${badge(st)} ${L.flags && L.flags.length ? L.flags.filter(f => f !== st).map(f => badge(f)).join(" ") : ""}
        <span class="muted small">${h(STATE_HELP[st] || "")}</span></div>
      ${intr.length ? `<div class="card" style="${(L.recent_intruders || []).length ? "border-color:var(--dot-err)" : ""}"><b style="${(L.recent_intruders || []).length ? "color:var(--danger)" : ""}">${(L.recent_intruders || []).length ? "Blocked IPs on port " + c.port + " (now)" : "Earlier blocked IPs on port " + c.port + " (none in the last minute)"}</b>
        <table class="t" style="margin-top:6px"><tr><th>IP</th><th class="num">Packets</th><th class="num">Size</th><th>Last</th></tr>
        ${intr.map(([ip, x]) => `<tr><td class="mono">${h(ip)}</td><td class="num">${x.count}</td><td class="num">${x.size}</td><td>${this.ago(x.last)}</td></tr>`).join("")}</table>
        <div class="small muted" style="margin-top:4px">These packets are not written. ${h(c.crane)} itself (${h(c.ip)}) is still collected.</div></div>` : ""}
      <div><h4>Identity</h4><div class="kv">
        <div><span>Terminal</span><span>${h(c.terminal)}</span></div>
        <div><span>Port</span><span>${c.port}${c.rule_warning ? ` <span class="warnicon" title="${h(c.rule_warning)}">⚠</span>` : ""}</span></div>
        <div><span>Registered IP</span><span class="mono">${h(c.ip || "– missing –")}</span></div>
        <div><span>Version</span><span>${h(c.version_name || "–")} (${c.packet_size || "?"} B)</span></div>
        <div><span>Writing to InfluxDB</span><span>${c.enabled ? "ON" : "OFF"}</span></div>
        <div><span>Notes</span><span>${h(c.notes || "–")}</span></div>
      </div></div>
      <div><h4>Link health</h4><div class="kv">
        <div><span>Packets / min</span><span>${L.pkt_min ?? 0}</span></div>
        <div><span>Last packet</span><span>${this.ago(L.last_packet)}</span></div>
        <div><span>Last size</span><span>${L.last_size ?? "–"} B (expects ${L.expected_size ?? "?"})</span></div>
        <div><span>Last from</span><span class="mono">${h(L.last_src || "–")}</span></div>
        <div><span>Received (since start)</span><span>${this.num(L.received)}</span></div>
        <div><span>Written</span><span>${this.num(L.written)}</span></div>
        <div><span>Blocked (wrong IP)</span><span>${this.num(L.dropped_ip)}</span></div>
        <div><span>Wrong size / parse</span><span>${this.num(L.wrong_size)} / ${this.num(L.parse_err)}</span></div>
        <div><span>PLC clock vs PC</span><span>${drift}</span></div>
        <div><span>Today: received / active</span><span>${this.num(today.received || 0)} / ${((today.active_sec || 0) / 3600).toFixed(1)} h</span></div>
        ${L.seen_ips && L.seen_ips.length ? `<div><span>Seen on this port</span><span class="mono">${h(L.seen_ips.join(", "))}</span></div>` : ""}
        ${L.bind_error ? `<div><span>Port error</span><span>${h(L.bind_error)}</span></div>` : ""}
      </div></div>
      <div><h4>Live values</h4>${vals.length ? `<div class="vals">${vals.map(([k, x]) => `<div><span>${h(k)}</span><span>${h(this.num(x))}</span></div>`).join("")}</div>` : `<div class="muted small">No values yet.</div>`}</div>
      <div><h4>Last 15 minutes</h4><div class="sparks" id="drSparks"></div></div>
      <div class="row">
        ${c.enabled ? `<button class="btn danger" id="drStop">■ Stop writing</button>` : `<button class="btn primary" id="drStart">▶ Start writing</button>`}
        <button class="btn" id="drVer">Change version</button>
        <button class="btn" id="drEdit">Edit settings</button>
        <button class="btn" id="drRaw">Packet X-ray</button>
        ${intr.length ? `<button class="btn" id="drRawBad">X-ray blocked packet</button>` : ""}
        <button class="btn" id="drData">Open in Data Explorer</button>
        <button class="btn" id="drExp">Export today</button>
      </div>
      <div><h4>Insights</h4>${d.insights.length ? d.insights.map(i => `<div class="ins"><b>${h(i.type.replace(/_/g, " "))}</b> · ${this.ago(i.ts)} ${i.count > 1 ? `(${i.count}×)` : ""}<br>${h(i.message)}</div>`).join("") : `<div class="muted small">Nothing unusual noticed.</div>`}</div>
      <div><h4>Recent events</h4><table class="t">${d.events.map(e => `<tr><td class="small nowrap">${this.fmtTime(e.ts)}</td><td>${badge(e.severity)}</td><td class="small">${h(e.message)}</td></tr>`).join("") || `<tr><td class="muted">none</td></tr>`}</table></div>`;
    const bd = $("#drawer .bd");
    const scroll = $("#drawer").scrollTop;
    bd.innerHTML = body;
    $("#drawer").scrollTop = scroll;
    $("#drawer .hd").innerHTML = `<b style="font-size:18px">${h(crane)}</b>${badge(st)}<span class="muted small">${h(c.terminal)} · port ${c.port} · ${h(c.ip)}</span><span class="right"></span><button class="btn sm" id="drClose">✕</button>`;
    $("#drClose").onclick = () => this.closeCrane();
    this.drawSparks($("#drSparks"), d.history);
    const on = (id, fn) => { const b = $("#" + id); if (b) b.onclick = fn; };
    on("drStop", () => Config.setWriting([crane], false));
    on("drStart", () => Config.setWriting([crane], true));
    on("drVer", () => Config.changeVersion([crane]));
    on("drEdit", () => Config.editCrane(crane));
    on("drRaw", () => this.xray(crane, "registered"));
    on("drRawBad", () => this.xray(crane, "intruder"));
    on("drData", () => { Data.prefill = {cranes: [crane]}; location.hash = "#explorer"; this.closeCrane(); });
    on("drExp", () => { Data.exportPrefill = {cranes: [crane], start: this.today() + "T00:00", stop: this.localInput(Date.now() / 1000)}; location.hash = "#export"; this.closeCrane(); });
  },

  drawSparks(el, hist) {
    if (!el) return;
    const names = {In_GANTRY1: "Gantry pos", In_TROLLEYPOMUX: "Trolley pos", In_HOIST: "Hoist pos", GANTRYSPEED1: "Gantry speed", HOISTSPEED1: "Hoist speed", In_GANTRYCurrent1: "Gantry current", In_HOISTCurrent1: "Hoist current", In_TROLLEYCurrent1: "Trolley current", Step: "Step"};
    const colors = ["--chart-blue", "--chart-teal", "--chart-amber", "--chart-purple", "--chart-red", "--chart-pink", "--chart-green", "--chart-blue", "--chart-gray"];
    const pts = (hist && hist.points) || [];
    if (!pts.length) { el.innerHTML = `<div class="muted small">No packets in the last 15 minutes.</div>`; return; }
    el.innerHTML = hist.fields.map((f, i) => {
      const last = pts[pts.length - 1][i + 1];
      return last === null || last === undefined ? "" : `<div class="spark"><div class="l"><span>${h(names[f] || f)}</span><b>${this.num(last)}</b></div><canvas data-i="${i}"></canvas></div>`;
    }).join("");
    $$("canvas", el).forEach(cv => {
      const i = +cv.dataset.i;
      this.spark(cv, pts.map(p => [p[0], p[i + 1]]), getComputedStyle(document.documentElement).getPropertyValue(colors[i]).trim());
    });
  },

  spark(cv, series, color) {
    const r = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    cv.width = W * r; cv.height = H * r;
    const g = cv.getContext("2d");
    g.scale(r, r);
    const s = series.filter(p => typeof p[1] === "number");
    if (s.length < 2) return;
    const t0 = s[0][0], t1 = s[s.length - 1][0];
    let lo = Math.min(...s.map(p => p[1])), hi = Math.max(...s.map(p => p[1]));
    if (hi === lo) { hi += 1; lo -= 1; }
    g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
    let prev = null;
    s.forEach(([t, v]) => {
      const x = (t - t0) / Math.max(1, t1 - t0) * (W - 2) + 1, y = H - 3 - (v - lo) / (hi - lo) * (H - 6);
      if (prev !== null && t - prev > 10) g.moveTo(x, y); else g.lineTo(x, y);
      prev = t;
    });
    g.stroke();
  },

  async xray(crane, which) {
    let d;
    try { d = await this.api(`/api/crane/${crane}/raw?which=${which}`); } catch (e) { return this.err(e); }
    if (d.empty) return this.toast("No packet received yet.");
    const words = d.words.map((w, i) => `<span><b>${i}</b>${w}</span>`).join("");
    const rows = d.decoded.map(f => `<tr class="${f.problem ? "sel" : ""}"><td>${h(f.name)}</td><td>${f.type}</td><td class="num">${f.type === "BIT" ? `${f.word}.${f.bit}` : f.slot}</td><td class="mono">${h(f.raw)}</td><td class="mono">${h(this.num(f.value, 4))}</td><td class="small">${h(f.problem || "")}</td></tr>`).join("");
    this.modal({title: `Packet X-ray · ${h(crane)} · ${which === "intruder" ? "blocked packet" : "latest packet"}`, wide: true, html: `
      <div class="row small muted">from <b class="mono">${h(d.ip)}</b> · ${d.size} bytes · ${this.fmtTime(d.ts)} · decoded with ${h(d.version ? d.version.name + " (" + d.version.packet_size + " B)" : "–")}</div>
      <h4 style="margin-top:10px">Raw words (slot: hex)</h4><div class="hex">${words}</div>
      <h4 style="margin-top:12px">Decoded fields</h4>
      <div class="tbl-wrap" style="max-height:50vh"><table class="t"><tr><th>Field</th><th>Type</th><th class="num">Slot</th><th>Raw bytes</th><th>Value</th><th></th></tr>${rows}</table></div>`});
  },
};

/* ── Live Status (the console table, live) ─────────────────────────────── */
App.views.status = {
  filter: "", stateFilter: "", sort: "crane",
  render(el) {
    el.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <h2 style="margin:0">Live Status</h2>
        <input id="stFilter" placeholder="Filter crane / IP / port…" value="${h(this.filter)}" style="width:220px">
        <div class="chips" id="stChips"></div>
        <span class="right small muted" id="stSummary"></span>
      </div>
      <div class="tbl-wrap"><table class="t" id="stTable"></table></div>
      <div class="small muted" style="margin-top:8px">Updates by itself every 1.5 s. Click a row for the crane's details. "Idle / no data" is normal: a PLC only sends while the crane is in Auto with an active work order.</div>`;
    $("#stFilter").oninput = e => { this.filter = e.target.value; this.update(App.live); };
  },
  update(live) {
    if (!$("#stTable")) return;
    const cr = live.cranes;
    const counts = {};
    cr.forEach(c => counts[c.state] = (counts[c.state] || 0) + 1);
    $("#stChips").innerHTML = [["", `All ${cr.length}`]].concat(Object.entries(counts).map(([s, n]) => [s, `${STATE_TEXT[s] || s} ${n}`]))
      .map(([s, t]) => `<button class="chip ${this.stateFilter === s ? "on" : ""}" data-s="${s}">${h(t)}</button>`).join("");
    $$("#stChips .chip").forEach(b => b.onclick = () => { this.stateFilter = b.dataset.s; this.update(App.live); });
    const f = this.filter.toLowerCase();
    let rows = cr.filter(c => (!this.stateFilter || c.state === this.stateFilter) &&
      (!f || [c.crane, c.ip, c.port, c.version].join(" ").toLowerCase().includes(f)));
    const k = this.sort;
    rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) || (a.crane > b.crane ? 1 : -1));
    const cols = [["crane", "Crane"], ["terminal", "Term."], ["port", "Port"], ["version", "Ver"], ["state", "State"], ["pkt_min", "Pkt/min"], ["last_packet", "Last packet"], ["last_size", "Size"], ["last_src", "From"], ["written", "Written"], ["dropped_ip", "Blocked"], ["note", "Note"]];
    $("#stTable").innerHTML = `<tr>${cols.map(([k2, t]) => `<th class="sort ${["pkt_min", "written", "dropped_ip", "last_size", "port"].includes(k2) ? "num" : ""}" data-k="${k2}">${t}${this.sort === k2 ? " ▾" : ""}</th>`).join("")}</tr>` +
      (rows.map(c => {
        const note = c.state === "IP_CONFLICT" ? `blocked ${(c.recent_intruders || []).join(", ")}` :
          c.state === "WRONG_SIZE" ? `size ${c.last_wrong_size || c.last_size} ≠ ${c.expected_size}` :
          c.state === "PORT_BUSY" ? h(c.bind_error || "") : c.state === "IDLE" ? "no packets - crane not in Auto / off / network?" :
          c.state === "OFF" ? `listening, not writing${c.pkt_min ? ` (${c.pkt_min}/min arriving)` : ""}` : (c.rule_warning || "");
        const ipOk = !c.last_src || c.last_src === c.ip;
        return `<tr class="click" data-c="${h(c.crane)}"><td><b>${h(c.crane)}</b></td><td>${h(c.terminal)}</td><td class="num">${c.port}${c.rule_warning ? ` <span class="warnicon" title="${h(c.rule_warning)}">⚠</span>` : ""}</td>
          <td>${h(c.version || "–")}</td><td>${badge(c.state)}</td><td class="num">${c.pkt_min || 0}</td><td>${App.ago(c.last_packet)}</td>
          <td class="num">${c.last_size || "–"}</td><td class="mono ${ipOk ? "" : "warnicon"}">${h(c.last_src || "–")}</td><td class="num">${App.num(c.written)}</td>
          <td class="num">${c.dropped_ip ? `<b style="color:var(--danger)">${App.num(c.dropped_ip)}</b>` : 0}</td><td class="small muted">${note}</td></tr>`;
      }).join("") || `<tr><td colspan="12" class="empty">No cranes registered${App.terminal ? " in " + App.terminal : ""}. Add them in <a href="#config">Configuration</a>.</td></tr>`);
    $$("#stTable th").forEach(th => th.onclick = () => { this.sort = th.dataset.k; this.update(App.live); });
    $$("#stTable tr.click").forEach(tr => tr.onclick = () => App.openCrane(tr.dataset.c));
    const ok = counts.OK || 0, idle = counts.IDLE || 0, al = cr.filter(c => ALARM_STATES.includes(c.state)).length;
    $("#stSummary").textContent = `OK ${ok} · Idle ${idle} · Alarm ${al} · Off ${counts.OFF || 0} · updated ${App.fmtTime(live.now, true, false)}`;
  },
};

/* ── Alarms & Events ───────────────────────────────────────────────────── */
App.views.alarms = {
  f: {days: 7, category: "", severity: "", crane: "", q: ""},
  render(el) {
    el.innerHTML = `
      <div class="row"><h2 style="margin:0">Active alarms</h2><span class="right"></span>
        <button class="btn" id="alTestSound">Test sound</button><button class="btn" id="alAckAll">Acknowledge all</button></div>
      <div id="alActive" class="col" style="margin:10px 0 22px"></div>
      <div class="row"><h2 style="margin:0">History</h2>
        <select id="hDays"><option value="1">Last 24 h</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select>
        <select id="hCat"><option value="">All categories</option>${["Communication", "Parsing", "Storage", "Configuration", "System", "Action"].map(c => `<option>${c}</option>`).join("")}</select>
        <select id="hSev"><option value="">All severities</option><option value="alarm">Alarms</option><option value="warning">Warnings</option><option value="info">Info</option></select>
        <input id="hCrane" placeholder="Crane" style="width:80px"><input id="hQ" placeholder="Search text" style="width:180px">
        <button class="btn" id="hGo">Show</button><button class="btn" id="hCsv">Download CSV</button></div>
      <div class="tbl-wrap" style="margin-top:10px;max-height:60vh"><table class="t" id="hTable"></table></div>`;
    const f = this.f;
    $("#hDays").value = f.days; $("#hCat").value = f.category; $("#hSev").value = f.severity; $("#hCrane").value = f.crane; $("#hQ").value = f.q;
    $("#alTestSound").onclick = () => { const m = App.muted; App.muted = false; App.beep(3); App.muted = m; };
    $("#alAckAll").onclick = () => App.ackAll();
    $("#hGo").onclick = () => this.loadHistory();
    $("#hCsv").onclick = () => { this.readF(); location.href = "/api/events?" + this.qs() + "&format=csv"; };
    this.loadHistory();
  },
  readF() { Object.assign(this.f, {days: $("#hDays").value, category: $("#hCat").value, severity: $("#hSev").value, crane: $("#hCrane").value.trim(), q: $("#hQ").value.trim()}); },
  qs() { const f = this.f; return new URLSearchParams({days: f.days, category: f.category, severity: f.severity, crane: f.crane, q: f.q, terminal: App.terminal}).toString(); },
  async loadHistory() {
    this.readF();
    const rows = await App.api("/api/events?" + this.qs());
    $("#hTable").innerHTML = `<tr><th>Time (Dubai)</th><th>Category</th><th>Type</th><th>Severity</th><th>Crane</th><th>Message</th><th>Status</th></tr>` +
      (rows.map(r => `<tr><td class="small" style="white-space:nowrap">${App.fmtTime(r.ts)}</td><td>${h(r.category)}</td><td class="small">${h(r.type)}</td><td>${badge(r.severity)}</td><td>${h(r.crane || "")}</td><td class="small">${h(r.message)}${r.ack_note ? `<br><i class="muted">note: ${h(r.ack_note)}</i>` : ""}</td>
        <td class="small">${r.severity === "alarm" ? (r.active ? "active" : `cleared ${App.fmtTime(r.cleared_ts, false)}`) + (r.acked ? " · ack" : "") : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="empty">Nothing in this period.</td></tr>`);
  },
  update(live) {
    const box = $("#alActive");
    if (!box) return;
    const sig = JSON.stringify(live.alarms.map(a => [a.id, a.acked, a.message]));
    if (sig === this._sig) return;
    this._sig = sig;
    box.innerHTML = live.alarms.map(a => {
      let extra = "";
      try {
        if (a.type === "WRONG_SIZE") {
          const crane = (live.cranes.find(c => c.crane === a.crane) || {});
          extra = `<button class="btn sm primary" data-switch="${h(a.crane)}">Switch version…</button>`;
        }
      } catch (e) { /* ignore */ }
      return `<div class="alarmcard ${a.acked ? "acked" : ""}"><div class="grow"><div class="row" style="gap:8px">${badge("alarm", a.type.replace(/_/g, " "))}<b>${h(a.crane || "Collector")}</b><span class="muted small">since ${App.fmtTime(a.ts)} (${App.ago(a.ts)})</span>${a.acked ? `<span class="badge warning">acknowledged</span>` : ""}</div>
        <div style="margin-top:4px">${h(a.message)}</div></div>
        <div class="col">${a.crane ? `<button class="btn sm" data-open="${h(a.crane)}">Details</button>` : ""}${extra}${a.acked ? "" : `<button class="btn sm" data-ack="${a.id}">Acknowledge</button>`}</div></div>`;
    }).join("") || `<div class="card empty">✓ No active alarms.</div>`;
    $$("[data-ack]", box).forEach(b => b.onclick = async () => {
      const note = prompt("Acknowledge. Note (optional):", "");
      if (note === null) return;
      await App.api(`/api/alarms/${b.dataset.ack}/ack`, {json: {note}});
      App.poll();
    });
    $$("[data-open]", box).forEach(b => b.onclick = () => App.openCrane(b.dataset.open));
    $$("[data-switch]", box).forEach(b => b.onclick = async () => {
      const rows = await App.api("/api/events?active=1&days=90&crane=" + b.dataset.switch);
      const ev = rows.find(r => r.type === "WRONG_SIZE");
      const det = ev && ev.details ? JSON.parse(ev.details) : {};
      Config.changeVersion([b.dataset.switch], (det.suggest || [])[0] && det.suggest[0].id, det.size);
    });
  },
};

/* ── Dashboard ─────────────────────────────────────────────────────────── */
App.views.dashboard = {
  date: null,
  render(el) {
    this.date = this.date || App.today();
    el.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h2 style="margin:0">Dashboard ${App.terminal ? "· " + h(App.meta.terminals[App.terminal].name) : "· all terminals"}</h2>
        <input type="date" id="dbDate" value="${this.date}"><button class="btn sm" id="dbToday">Today</button><button class="btn sm" id="dbYest">Yesterday (daily digest)</button>
        <span class="right small muted">Figures come from the collector's own counters (kept locally, 90 days).</span></div>
      <div id="dbBody"><div class="empty">Loading…</div></div>`;
    $("#dbDate").onchange = e => { this.date = e.target.value; this.load(); };
    $("#dbToday").onclick = () => { this.date = App.today(); $("#dbDate").value = this.date; this.load(); };
    $("#dbYest").onclick = () => { this.date = App.localInput(Date.now() / 1000 - 86400).slice(0, 10); $("#dbDate").value = this.date; this.load(); };
    this.load();
  },
  async load() {
    const d = await App.api(`/api/dashboard?date=${this.date}` + (App.terminal ? "&terminal=" + App.terminal : ""));
    const T = d.totals;
    const tile = (v, l) => `<div class="tile"><div class="v">${v ?? "–"}</div><div class="l">${l}</div></div>`;
    const maxW = Math.max(1, ...d.week.map(w => w.received));
    const bars = d.week.map(w => `<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">
        <div class="small muted">${App.num(w.received)}</div>
        <div style="width:70%;background:var(--chart-blue);border-radius:4px 4px 0 0;height:${Math.round(110 * w.received / maxW)}px" title="${w.date}: ${w.received} packets, ${(w.active_sec / 3600).toFixed(1)} h active"></div>
        <div class="small">${w.date.slice(5)}</div></div>`).join("");
    const cov = Object.entries(d.coverage).map(([t, g]) => {
      const n = g.grid[0] ? g.grid[0].cells.length : 0;
      return `<div class="card flat"><h3>${h(t)} coverage</h3>
        <div class="cov" style="grid-template-columns:22px repeat(${n},34px)"><div></div>${Array.from({length: n}, (_, i) => `<div class="ln small muted">${String(i + 1).padStart(2, "0")}</div>`).join("")}
        ${g.grid.map(r => `<div class="ln">${r.lane}</div>${r.cells.map(c => `<div class="c ${c.status}" title="${c.crane}: ${c.status === "none" ? "not onboarded" : c.status}">${c.crane.slice(1)}</div>`).join("")}`).join("")}</div>
        ${g.extra.length ? `<div class="small muted" style="margin-top:6px">Also registered under ${t}: ${h(g.extra.join(", "))}</div>` : ""}
        <div class="legend"><span><i class="dot ok"></i>collecting</span><span><i class="dot attn"></i>registered, writing off</span><span><i class="dot"></i>not onboarded</span></div></div>`;
    }).join("");
    $("#dbBody").innerHTML = `
      <div class="tiles">${tile(T.registered, "cranes registered")}${tile(T.enabled, "writing to InfluxDB")}${tile(T.with_data_today, "sent data this day")}
        ${tile(App.num(T.packets_today), "packets")}${tile(T.active_hours, "Auto hours (sum)")}${tile(App.num(T.moves), "work orders (moves)")}
        ${tile(T.quality_avg != null ? T.quality_avg + "%" : "–", "average data quality")}${tile(T.insights, "insights")}</div>
      <div class="grid" style="grid-template-columns:2fr 1fr;margin-top:14px">
        <div class="card flat"><h3>Packets per day (7 days)</h3><div style="display:flex;align-items:flex-end;height:150px;gap:4px">${bars}</div></div>
        <div class="card flat"><h3>Versions in use</h3>${Object.entries(d.versions).map(([v, n]) => `<div class="row" style="justify-content:space-between"><span>${h(v)}</span><b>${n} crane${n > 1 ? "s" : ""}</b></div>`).join("") || `<div class="muted">–</div>`}</div>
      </div>
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(520px,1fr));margin-top:14px">${cov}</div>
      <h3 style="margin-top:16px">Per crane · ${h(d.date)}</h3>
      <div class="tbl-wrap"><table class="t"><tr><th>Crane</th><th>Term.</th><th>Version</th><th>Writing</th><th class="num">Packets</th><th class="num">Written</th><th class="num">Blocked IP</th><th class="num">Wrong size</th><th class="num">Auto h</th><th class="num">Moves</th><th>First / last packet</th><th>Quality</th><th>Notes</th><th class="num">Alarms 7d</th></tr>
        ${d.cranes.map(c => `<tr class="click" data-c="${h(c.crane)}"><td><b>${h(c.crane)}</b></td><td>${h(c.terminal)}</td><td>${h(c.version || "–")}</td><td>${c.enabled ? "ON" : "OFF"}</td><td class="num">${App.num(c.received)}</td><td class="num">${App.num(c.written)}</td><td class="num">${App.num(c.dropped_ip)}</td><td class="num">${App.num(c.wrong_size)}</td><td class="num">${c.active_hours}</td><td class="num">${c.moves}</td>
          <td class="small">${c.first_ts ? App.fmtTime(c.first_ts, false, false) + " – " + App.fmtTime(c.last_ts, false, false) : "–"}</td>
          <td>${c.quality == null ? "–" : `<div class="row" style="gap:6px"><div class="progress" style="min-width:60px"><i style="width:${c.quality}%;background:${c.quality > 90 ? "var(--dot-ok)" : c.quality > 70 ? "var(--dot-attn)" : "var(--dot-err)"}"></i></div><b>${c.quality}</b></div>`}</td>
          <td class="small muted">${h(c.quality_notes.join("; "))}</td><td class="num">${c.alarms_7d}</td></tr>`).join("") || `<tr><td colspan="14" class="empty">No cranes.</td></tr>`}</table></div>
      <h3 style="margin-top:16px">Insights · ${h(d.date)}</h3>
      ${d.insights.map(i => `<div class="ins"><b>${h(i.crane)} · ${h(i.type.replace(/_/g, " "))}</b> ${i.count > 1 ? `(${i.count}×)` : ""} · ${App.fmtTime(i.ts, false, false)}<br>${h(i.message)}</div>`).join("") || `<div class="muted">Nothing unusual noticed this day.</div>`}`;
    $$("#dbBody tr.click").forEach(tr => tr.onclick = () => App.openCrane(tr.dataset.c));
  },
};
