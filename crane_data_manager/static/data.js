/* Data Explorer, Query, Export. Includes a small canvas line chart (offline). */
"use strict";
const Data = {
  prefill: null, exportPrefill: null,
  state: {cranes: [], fields: [], start: null, stop: null, window: "raw", fn: "mean"},

  cranesAll() { return (App.live ? App.live.cranes : []).map(c => c.crane).sort(); },

  /* crane chips */
  cranePicker(el, selected, onChange) {
    const all = this.cranesAll();
    const draw = () => {
      el.innerHTML = `<div class="row" style="gap:6px;margin-bottom:4px"><b class="small">Cranes</b><button class="btn ghost sm" data-a="all">all</button><button class="btn ghost sm" data-a="none">none</button></div>
        <div class="chips">${all.map(c => `<button class="chip ${selected.includes(c) ? "on" : ""}" data-c="${c}">${c}</button>`).join("") || `<span class="muted small">no cranes registered</span>`}</div>`;
      $$(".chip", el).forEach(b => b.onclick = () => { const i = selected.indexOf(b.dataset.c); i >= 0 ? selected.splice(i, 1) : selected.push(b.dataset.c); draw(); onChange && onChange(); });
      $$("[data-a]", el).forEach(b => b.onclick = () => { selected.splice(0, selected.length, ...(b.dataset.a === "all" ? all : [])); draw(); onChange && onChange(); });
    };
    draw();
  },

  /* field groups with checkboxes */
  async fieldPicker(el, cranes, selected) {
    const cat = await App.api("/api/fields" + (cranes.length ? "?cranes=" + cranes.join(",") : ""));
    const groups = {};
    Object.entries(cat).forEach(([n, f]) => (groups[f.group] = groups[f.group] || []).push(n));
    const order = App.meta.groups.filter(g => groups[g]).concat(Object.keys(groups).filter(g => !App.meta.groups.includes(g)));
    el.innerHTML = `<div class="row" style="gap:6px;margin-bottom:4px"><b class="small">Fields</b><input id="fpSearch" placeholder="search" style="width:120px;padding:3px 6px"><button class="btn ghost sm" data-a="none">clear</button><span class="small muted" id="fpCount"></span></div>
      <div class="fieldpick">${order.map(g => `<details ${groups[g].some(n => selected.includes(n)) ? "open" : ""}><summary><input type="checkbox" data-g="${h(g)}"> ${h(g)} <span class="muted small">(${groups[g].length})</span></summary>
        <div class="fl">${groups[g].map(n => `<label class="chk" title="${h(cat[n].type + (cat[n].description ? " · " + cat[n].description : ""))}"><input type="checkbox" data-f="${h(n)}" ${selected.includes(n) ? "checked" : ""}>${h(n)}</label>`).join("")}</div></details>`).join("")}</div>`;
    const sync = () => {
      selected.splice(0, selected.length, ...$$("[data-f]", el).filter(x => x.checked).map(x => x.dataset.f));
      $$("[data-g]", el).forEach(gc => { const fs = groups[gc.dataset.g].map(n => $(`[data-f="${CSS.escape(n)}"]`, el)); gc.checked = fs.every(x => x.checked); gc.indeterminate = !gc.checked && fs.some(x => x.checked); });
      $("#fpCount", el).textContent = selected.length ? `${selected.length} selected` : "none = all fields";
    };
    $$("[data-f]", el).forEach(x => x.onchange = sync);
    $$("[data-g]", el).forEach(gc => { gc.onclick = e => e.stopPropagation(); gc.onchange = () => { groups[gc.dataset.g].forEach(n => $(`[data-f="${CSS.escape(n)}"]`, el).checked = gc.checked); sync(); }; });
    $("[data-a=none]", el).onclick = () => { $$("[data-f]", el).forEach(x => x.checked = false); sync(); };
    $("#fpSearch", el).oninput = e => { const q = e.target.value.toLowerCase(); $$("label.chk", el).forEach(l => l.style.display = l.textContent.toLowerCase().includes(q) ? "" : "none"); if (q) $$("details", el).forEach(d => d.open = true); };
    sync();
    return cat;
  },

  timePicker(el, st) {
    const now = Date.now() / 1000;
    st.start = st.start || App.localInput(now - 3600);
    st.stop = st.stop || App.localInput(now);
    el.innerHTML = `<b class="small">Time (Dubai)</b>
      <div class="chips" style="margin:4px 0">${[["1h", "Last hour"], ["6h", "6 h"], ["today", "Today"], ["yest", "Yesterday"], ["7d", "7 days"]].map(([k, t]) => `<button class="chip" data-q="${k}">${t}</button>`).join("")}</div>
      <div class="row" style="gap:6px"><input type="datetime-local" id="tpA" value="${st.start}"><span>→</span><input type="datetime-local" id="tpB" value="${st.stop}"></div>`;
    const set = (a, b) => { st.start = App.localInput(a); st.stop = App.localInput(b); $("#tpA", el).value = st.start; $("#tpB", el).value = st.stop; };
    $$("[data-q]", el).forEach(b => b.onclick = () => {
      const n = Date.now() / 1000, day0 = Math.floor((n + 4 * 3600) / 86400) * 86400 - 4 * 3600;
      ({"1h": () => set(n - 3600, n), "6h": () => set(n - 6 * 3600, n), today: () => set(day0, n), yest: () => set(day0 - 86400, day0), "7d": () => set(n - 7 * 86400, n)})[b.dataset.q]();
    });
    $("#tpA", el).onchange = e => st.start = e.target.value;
    $("#tpB", el).onchange = e => st.stop = e.target.value;
  },

  resPicker(st) {
    return `<label class="f">Resolution<select id="resW">${[["raw", "Raw (every packet ≈1.2 s)"], ["10s", "10 s"], ["30s", "30 s"], ["1m", "1 min"], ["5m", "5 min"], ["15m", "15 min"], ["1h", "1 hour"]].map(([k, t]) => `<option value="${k}" ${st.window === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="f">Per interval<select id="resF">${[["mean", "Average (numbers) / last (others)"], ["last", "Last value"], ["max", "Maximum"], ["min", "Minimum"]].map(([k, t]) => `<option value="${k}" ${st.fn === k ? "selected" : ""}>${t}</option>`).join("")}</select></label>`;
  },
  readRes(st) { st.window = $("#resW").value; st.fn = $("#resF").value; },

  /* ── chart ── */
  chart(box, columns, rows) {
    const ti = 0, ci = columns.indexOf("crane_id");
    const numCols = columns.map((c, i) => i).filter(i => i !== ti && i !== ci && rows.some(r => typeof r[i] === "number"));
    const series = {};
    rows.forEach(r => {
      const t = Date.parse(r[ti].replace(" ", "T") + "+04:00") / 1000;
      numCols.forEach(i => { if (typeof r[i] === "number") { const k = `${r[ci] || ""} ${columns[i]}`.trim(); (series[k] = series[k] || []).push([t, r[i]]); } });
    });
    const keys = Object.keys(series);
    const pal = ["--chart-blue", "--chart-amber", "--chart-teal", "--chart-red", "--chart-purple", "--chart-pink", "--chart-green", "--chart-gray"].map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());
    const vis = new Set(keys.slice(0, 6));
    box.innerHTML = keys.length ? `<div class="chartbox"><canvas></canvas><div class="chart-tip"></div></div>
      <div class="chart-legend">${keys.map((k, i) => `<label><input type="checkbox" data-k="${h(k)}" ${vis.has(k) ? "checked" : ""}><i style="background:${pal[i % pal.length]}"></i>${h(k)}</label>`).join("")}</div>
      <div class="small muted">Tick series to show them (max 8 at once is easiest to read). Hover for values.</div>` : `<div class="empty">No numeric data to chart.</div>`;
    if (!keys.length) return;
    const cv = $("canvas", box), tip = $(".chart-tip", box);
    const draw = (hx) => {
      const r = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
      cv.width = W * r; cv.height = H * r;
      const g = cv.getContext("2d"); g.scale(r, r);
      const shown = keys.filter(k => vis.has(k));
      const all = shown.flatMap(k => series[k]);
      if (!all.length) return;
      const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
      let lo = Math.min(...all.map(p => p[1])), hi = Math.max(...all.map(p => p[1]));
      if (lo === hi) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
      const L = 56, R = 10, T = 10, B = 26;
      const X = t => L + (t - t0) / Math.max(1, t1 - t0) * (W - L - R), Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
      const css = getComputedStyle(document.documentElement);
      g.font = "11px Segoe UI, sans-serif"; g.fillStyle = css.getPropertyValue("--text2"); g.strokeStyle = css.getPropertyValue("--s2"); g.lineWidth = 1;
      for (let i = 0; i <= 5; i++) { const v = lo + (hi - lo) * i / 5, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - R, y); g.stroke(); g.fillText(Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2), 4, y + 4); }
      for (let i = 0; i <= 6; i++) { const t = t0 + (t1 - t0) * i / 6; g.fillText(App.fmtTime(t, false, (t1 - t0) > 86400), X(t) - 18, H - 8); }
      shown.forEach(k => {
        const s = series[k]; g.strokeStyle = pal[keys.indexOf(k) % pal.length]; g.lineWidth = 1.6; g.beginPath();
        let prev = null;
        s.forEach(([t, v]) => { const x = X(t), y = Y(v); if (prev !== null && t - prev > 60 && (t1 - t0) < 86400 * 2) g.moveTo(x, y); else g.lineTo(x, y); prev = t; });
        g.stroke();
      });
      if (hx != null && hx > L) {
        const t = t0 + (hx - L) / (W - L - R) * (t1 - t0);
        g.strokeStyle = css.getPropertyValue("--text2"); g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, H - B); g.stroke();
        const lines = [App.fmtTime(t)];
        shown.forEach(k => { const s = series[k]; let best = null; for (const p of s) { if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; } if (best) lines.push(`${k}: ${App.num(best[1], 3)}`); });
        tip.innerHTML = lines.map(h).join("<br>"); tip.style.display = "block";
        tip.style.left = Math.min(hx + 14, W - 220) + "px"; tip.style.top = "14px";
      } else tip.style.display = "none";
    };
    draw();
    cv.onmousemove = e => draw(e.offsetX);
    cv.onmouseleave = () => draw(null);
    $$("[data-k]", box).forEach(x => x.onchange = () => { x.checked ? vis.add(x.dataset.k) : vis.delete(x.dataset.k); draw(); });
  },

  table(el, res, pageSize = 200) {
    let page = 0;
    const draw = () => {
      const rows = res.rows.slice(page * pageSize, (page + 1) * pageSize);
      const pages = Math.max(1, Math.ceil(res.rows.length / pageSize));
      el.innerHTML = `<div class="row small muted" style="margin-bottom:6px">${App.num(res.rows.length)} rows${res.truncated ? " (limit reached - narrow the time range or use a coarser resolution; Export has no limit)" : ""}
        <span class="right"></span><button class="btn sm" id="tbPrev" ${page ? "" : "disabled"}>‹</button> page ${page + 1} / ${pages} <button class="btn sm" id="tbNext" ${page < pages - 1 ? "" : "disabled"}>›</button></div>
        <div class="tbl-wrap" style="max-height:62vh"><table class="t dense"><tr>${res.columns.map(c => `<th>${h(c)}</th>`).join("")}</tr>
        ${rows.map(r => `<tr>${r.map(v => `<td>${h(v === null || v === undefined ? "" : typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : v)}</td>`).join("")}</tr>`).join("")}</table></div>`;
      const p = $("#tbPrev", el), n = $("#tbNext", el);
      if (p) p.onclick = () => { page--; draw(); };
      if (n) n.onclick = () => { page++; draw(); };
    };
    draw();
  },
};

/* ── Data Explorer ── */
App.views.explorer = {
  render(el) {
    const st = Data.state;
    if (Data.prefill) { Object.assign(st, {fields: [], ...Data.prefill}); Data.prefill = null; }
    if (!st.cranes.length && App.live) st.cranes = App.live.cranes.slice(0, 1).map(c => c.crane);
    el.innerHTML = `<div class="layout2">
      <div class="col card">
        <h2>Data Explorer</h2>
        <div id="exCr"></div><div id="exTime"></div>
        <div class="row">${Data.resPicker(st)}</div>
        <div id="exFields"></div>
        <div class="row"><button class="btn primary" id="exGo">Show data</button><button class="btn" id="exToExport">Export this…</button><button class="btn" id="exToQuery">Show the query</button></div>
      </div>
      <div class="col"><div class="seg" id="exMode"><button data-m="chart" class="on">Chart</button><button data-m="table">Table</button></div><div id="exOut" class="card flat"><div class="empty">Choose cranes, time and fields, then <b>Show data</b>.<br>Tip: pick a group (e.g. Hoist) for a quick look.</div></div></div></div>`;
    const reloadFields = () => Data.fieldPicker($("#exFields"), st.cranes, st.fields);
    Data.cranePicker($("#exCr"), st.cranes, reloadFields);
    Data.timePicker($("#exTime"), st);
    reloadFields();
    let mode = "chart", res = null;
    const show = () => { if (!res) return; mode === "chart" ? Data.chart($("#exOut"), res.columns, res.rows) : Data.table($("#exOut"), res); };
    $$("#exMode button").forEach(b => b.onclick = () => { mode = b.dataset.m; $$("#exMode button").forEach(x => x.classList.toggle("on", x === b)); show(); });
    $("#exGo").onclick = async () => {
      Data.readRes(st);
      if (!st.cranes.length) return App.toast("Choose at least one crane");
      $("#exOut").innerHTML = `<div class="empty">Querying InfluxDB…</div>`;
      try { res = await App.api("/api/query", {json: {...st, max_rows: 20000}}); show(); }
      catch (e) { $("#exOut").innerHTML = `<div class="empty" style="color:var(--danger)">${h(e.message)}</div>`; }
    };
    $("#exToExport").onclick = () => { Data.readRes(st); Data.exportPrefill = {...st}; location.hash = "#export"; };
    $("#exToQuery").onclick = () => { Data.readRes(st); App.views.query.pending = {...st}; location.hash = "#query"; };
  },
};

/* ── Query ── */
App.views.query = {
  pending: null,
  st: {cranes: [], fields: [], start: null, stop: null, window: "raw", fn: "mean"},
  render(el) {
    const st = this.st;
    if (this.pending) { Object.assign(st, this.pending); this.pending = null; }
    el.innerHTML = `
      <div class="card" style="margin-bottom:12px"><div class="row"><b>Smart search</b>
        <input id="qSmart" class="grow" placeholder='e.g.  "E208 hoist current yesterday 10-12"   ·   "T2 anti-collision today"   ·   "C210 gantry speed last 3 hours every 1m"'>
        <button class="btn primary" id="qSmartGo">Fill in</button></div><div class="small muted" id="qSmartExpl" style="margin-top:4px">Understands crane IDs, T2/T3/T4, motions (gantry, trolley, hoist), measures (current, speed, torque, position, voltage), groups (load cells, anti-collision, brakes, job) and times (today, yesterday, last 3 hours, 17.11, 10-12, every 1m). Works offline.</div></div>
      <div class="layout2"><div class="col card">
        <h2>Query builder</h2>
        <div class="row small"><b>Templates:</b><button class="btn sm" data-tpl="full">Full record (like the notebooks)</button><button class="btn sm" data-tpl="validate">Validate the data (last 100)</button></div>
        <div id="qCr"></div><div id="qTime"></div><div class="row">${Data.resPicker(st)}</div><div id="qFields"></div>
        <div class="row"><button class="btn primary" id="qRun">Run</button><button class="btn" id="qFlux">Show Flux</button><button class="btn" id="qSave">Save query…</button></div>
        <h3 style="margin-top:8px">Saved queries</h3><div id="qSaved" class="col small"></div>
      </div>
      <div class="col">
        <div class="card flat"><div class="row"><b>Flux</b><span class="small muted">read-only - copy it into InfluxDB notebooks if you like</span><span class="right"></span><button class="btn sm" id="qCopy">Copy</button><button class="btn sm" id="qRunFlux">Run this Flux</button></div>
          <textarea id="qFluxTxt" class="mono" style="min-height:150px;font-size:12px" placeholder="Generated Flux appears here. Advanced users can edit and run it (writing / deleting is blocked)."></textarea></div>
        <div id="qOut" class="card flat"><div class="empty">Results appear here.</div></div></div></div>`;
    const reloadFields = () => Data.fieldPicker($("#qFields"), st.cranes, st.fields);
    const drawAll = () => { Data.cranePicker($("#qCr"), st.cranes, reloadFields); Data.timePicker($("#qTime"), st); $("#resW").value = st.window; $("#resF").value = st.fn; reloadFields(); };
    drawAll();
    this.limit = null;
    $("#qSmartGo").onclick = async () => {
      try {
        const r = await App.api("/api/smart", {json: {text: $("#qSmart").value}});
        Object.assign(st, {cranes: r.cranes, fields: r.fields, start: r.start, stop: r.stop, window: r.window, fn: r.fn});
        $("#qSmartExpl").textContent = "Understood: " + r.explanation;
        drawAll();
        if (r.cranes.length) this.run();
      } catch (e) { App.err(e); }
    };
    $("#qSmart").onkeydown = e => { if (e.key === "Enter") $("#qSmartGo").click(); };
    $$("[data-tpl]").forEach(b => b.onclick = () => {
      if (!st.cranes.length) st.cranes = Data.cranesAll().slice(0, 1);
      st.fields.splice(0); st.window = "raw";
      this.limit = b.dataset.tpl === "validate" ? 100 : null;
      if (b.dataset.tpl === "validate") { const n = Date.now() / 1000; st.start = App.localInput(n - 7 * 86400); st.stop = App.localInput(n); }
      drawAll(); this.flux();
    });
    $("#qRun").onclick = () => this.run();
    $("#qFlux").onclick = () => this.flux();
    $("#qCopy").onclick = () => { navigator.clipboard && navigator.clipboard.writeText($("#qFluxTxt").value); App.toast("Copied"); };
    $("#qRunFlux").onclick = async () => {
      $("#qOut").innerHTML = `<div class="empty">Running…</div>`;
      try { Data.table($("#qOut"), await App.api("/api/query/flux", {json: {flux: $("#qFluxTxt").value}})); } catch (e) { $("#qOut").innerHTML = `<div class="empty" style="color:var(--danger)">${h(e.message)}</div>`; }
    };
    $("#qSave").onclick = async () => {
      Data.readRes(st);
      const name = prompt("Name for this query:", st.cranes.join(",") + " " + (st.fields[0] || "all fields"));
      if (!name) return;
      await App.api("/api/saved_queries", {json: {name, spec: {...st, relative: (new Date(st.stop) - new Date(st.start)) / 1000}}});
      this.loadSaved();
    };
    this.loadSaved();
  },
  spec() { Data.readRes(this.st); return {...this.st, limit: this.limit}; },
  async flux() {
    try { $("#qFluxTxt").value = (await App.api("/api/query/flux", {json: {build: this.spec()}})).flux; } catch (e) { App.err(e); }
  },
  async run() {
    const sp = this.spec();
    if (!sp.cranes.length) return App.toast("Choose at least one crane");
    await this.flux();
    $("#qOut").innerHTML = `<div class="empty">Querying InfluxDB…</div>`;
    try {
      const r = await App.api("/api/query", {json: {...sp, max_rows: sp.limit || 5000}});
      Data.table($("#qOut"), r);
    } catch (e) { $("#qOut").innerHTML = `<div class="empty" style="color:var(--danger)">${h(e.message)}</div>`; }
  },
  async loadSaved() {
    const list = await App.api("/api/saved_queries");
    $("#qSaved").innerHTML = list.map(q => `<div class="row" style="gap:6px"><a href="#" data-id="${q.id}">${h(q.name)}</a><span class="muted">${h(q.spec.cranes.join(","))}</span><span class="right"></span><button class="btn ghost sm" data-del="${q.id}">✕</button></div>`).join("") || `<span class="muted">none yet</span>`;
    $$("#qSaved [data-id]").forEach(a => a.onclick = e => {
      e.preventDefault();
      const q = list.find(x => x.id == a.dataset.id).spec;
      const n = Date.now() / 1000;
      Object.assign(this.st, q, q.relative ? {start: App.localInput(n - q.relative), stop: App.localInput(n)} : {});
      this.render($("#view"));
      this.run();
    });
    $$("#qSaved [data-del]").forEach(b => b.onclick = async () => { if (confirm("Delete this saved query?")) { await App.api("/api/saved_queries/" + b.dataset.del, {method: "DELETE"}); this.loadSaved(); } });
  },
};

/* ── Export ── */
App.views.export = {
  st: {cranes: [], fields: [], start: null, stop: null, window: "raw", fn: "mean", layout: "file_per_crane_day", format: "xlsx", time_style: "local", plctime: true, from_time: "", to_time: ""},
  render(el) {
    const st = this.st;
    if (Data.exportPrefill) { Object.assign(st, Data.exportPrefill); Data.exportPrefill = null; }
    el.innerHTML = `<div class="layout2"><div class="col card">
        <h2>Excel / CSV export</h2>
        <div id="xCr"></div><div id="xTime"></div>
        <div class="row"><label class="chk"><input type="checkbox" id="xWin" ${st.from_time ? "checked" : ""}> Only a time window on every day</label>
          <input type="time" id="xFrom" value="${st.from_time || "08:00"}"> – <input type="time" id="xTo" value="${st.to_time || "17:00"}"></div>
        <div class="row">${Data.resPicker(st)}</div>
        <label class="f">File layout<select id="xLayout">
          <option value="file_per_crane_day">One file per crane per day, zipped (CRANE_YYYY-MM-DD - Gantry Watch naming)</option>
          <option value="sheet_per_crane">One file, one sheet per crane</option>
          <option value="combined">One file, all cranes in one sheet</option></select></label>
        <div class="row"><label class="f">Format<select id="xFmt"><option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV</option></select></label>
          <label class="f">Time column<select id="xTs"><option value="local">Dubai time (Time, Crane …)</option><option value="influx">Like an InfluxDB download (_time UTC, crane_id …)</option></select></label></div>
        <label class="chk"><input type="checkbox" id="xPlc" ${st.plctime ? "checked" : ""}> Include the PLCTime column</label>
        <div id="xFields"></div>
        <div class="small muted" id="xEst"></div>
        <div class="row"><button class="btn primary" id="xGo">Start export</button></div>
      </div>
      <div class="col"><div class="card flat"><h3>Exports</h3><div id="xJobs"></div><div class="small muted">The last 20 exports are kept for download. Exports run in the background - you can keep working.</div></div></div></div>`;
    $("#xLayout").value = st.layout; $("#xFmt").value = st.format; $("#xTs").value = st.time_style;
    const reloadFields = () => Data.fieldPicker($("#xFields"), st.cranes, st.fields);
    Data.cranePicker($("#xCr"), st.cranes, () => { reloadFields(); this.estimate(); });
    Data.timePicker($("#xTime"), st);
    reloadFields();
    $("#xTime").addEventListener("change", () => this.estimate());
    $("#xTime").addEventListener("click", () => setTimeout(() => this.estimate(), 50));
    ["#resW", "#xWin", "#xFrom", "#xTo"].forEach(s => $(s).addEventListener("change", () => this.estimate()));
    $("#xGo").onclick = () => this.go();
    this.estimate();
    this.loadJobs();
    clearInterval(this.jt);
    this.jt = setInterval(() => { if (App.view === "export") this.loadJobs(); else clearInterval(this.jt); }, 2000);
  },
  read() {
    const st = this.st;
    Data.readRes(st);
    Object.assign(st, {layout: $("#xLayout").value, format: $("#xFmt").value, time_style: $("#xTs").value, plctime: $("#xPlc").checked,
      from_time: $("#xWin").checked ? $("#xFrom").value : "", to_time: $("#xWin").checked ? $("#xTo").value : ""});
    return st;
  },
  estimate() {
    const st = this.read();
    let hours = Math.max(0, (new Date(st.stop) - new Date(st.start)) / 3.6e6);
    if (st.from_time && st.to_time) { const [a, b] = [st.from_time, st.to_time].map(t => +t.split(":")[0] + t.split(":")[1] / 60); hours = hours / 24 * ((b - a + 24) % 24 || 24); }
    const per = {raw: 3000, "10s": 360, "30s": 120, "1m": 60, "5m": 12, "15m": 4, "1h": 1}[st.window] || 3000;
    const rows = Math.round(hours * per * st.cranes.length);
    $("#xEst").innerHTML = `Up to about <b>${App.num(rows)}</b> rows (only while cranes were in Auto: usually fewer).${rows > 1e6 && st.layout !== "file_per_crane_day" ? " Large: sheets are split at Excel's row limit; one file per crane-day is easier." : ""}`;
  },
  async go() {
    const st = this.read();
    if (!st.cranes.length) return App.toast("Choose at least one crane");
    try { await App.api("/api/export", {json: st}); App.toast("Export started", "ok"); this.loadJobs(); } catch (e) { App.err(e); }
  },
  async loadJobs() {
    const el = $("#xJobs");
    if (!el) return;
    const jobs = await App.api("/api/exports");
    el.innerHTML = `<table class="t"><tr><th>Started</th><th>Cranes</th><th>Period</th><th>Status</th><th></th></tr>` + (jobs.map(j => `<tr>
      <td class="small">${App.fmtTime(j.ts)}</td><td class="small">${h((j.spec.cranes || []).join(", "))}</td>
      <td class="small">${h((j.spec.start || "").replace("T", " "))} → ${h((j.spec.stop || "").replace("T", " "))}${j.spec.from_time ? `<br>daily ${h(j.spec.from_time)}–${h(j.spec.to_time)}` : ""} · ${h(j.spec.window)}</td>
      <td>${j.status === "running" || j.status === "queued" ? `<div class="progress"><i style="width:${j.progress}%"></i></div><span class="small muted">${h(j.message || "")}</span>` : j.status === "done" ? `${badge("ok", "done")} <span class="small">${h(j.message)}</span>` : `${badge("error", "failed")} <span class="small">${h(j.message)}</span>`}</td>
      <td>${j.status === "done" ? `<a class="btn sm primary" href="/api/exports/${j.id}/download">Download</a>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">No exports yet.</td></tr>`) + `</table>`;
  },
};
