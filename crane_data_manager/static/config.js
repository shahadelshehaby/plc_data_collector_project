/* Configuration: cranes (manual + Excel import with preview), packet versions
   (editor with live test), collector, notifications, InfluxDB, system.
   Every critical action goes through App.confirm (summary + reason + typed word). */
"use strict";
const GROUP_COLORS = {"Text": "#888780", "Spreader": "#7F77DD", "Load cells": "#D4537E", "Gantry": "#378ADD", "Trolley": "#5DCAA5", "Hoist": "#EF9F27",
  "Drive currents": "#E24B4A", "Drive voltages": "#A32D2D", "Power cable reel": "#639922", "Neighbour cranes": "#185FA5", "Control": "#5F5E5A",
  "Job & automation": "#0C447C", "Status words": "#2C2C2A", "Crane state": "#854F0B", "Anti-collision": "#A32D2D", "Brakes": "#3B6D11", "Other": "#B4B2A9"};

const Config = {
  versions: null,
  async loadVersions() { this.versions = await App.api("/api/versions"); return this.versions; },

  versionOptions(program, selected) {
    const vs = this.versions || [];
    const own = vs.filter(v => v.program === program), other = vs.filter(v => v.program !== program);
    const o = v => `<option value="${v.id}" ${v.id == selected ? "selected" : ""}>${h(v.program)} ${h(v.name)} · ${v.packet_size} B · ${v.field_count} fields</option>`;
    return `<option value="">– choose –</option>${own.length ? `<optgroup label="${h(program)} (expected for this crane)">${own.map(o).join("")}</optgroup>` : ""}${other.length ? `<optgroup label="Other programs">${other.map(o).join("")}</optgroup>` : ""}`;
  },

  /* ── shared actions (used by drawer, tables, alarms) ── */
  async setWriting(cranes, enabled, all = false) {
    const list = `<ul>${cranes.map(c => `<li><b>${h(c)}</b></li>`).join("")}</ul>`;
    const typed = enabled ? null : cranes.length === 1 ? cranes[0] : all ? "STOP ALL" : `STOP ${cranes.length}`;
    const r = await App.confirm({
      title: enabled ? `Start writing ${cranes.length > 1 ? cranes.length + " cranes" : cranes[0]}` : `Stop writing ${cranes.length > 1 ? cranes.length + " cranes" : cranes[0]}`,
      danger: !enabled, typed, okText: enabled ? "Start writing" : "Stop writing",
      summary: enabled ? `These cranes will be <b>written to InfluxDB again</b>:${list}` :
        `<b>No data from these cranes will be written to InfluxDB</b> until you start them again:${list}The collector keeps listening, so the platform still shows whether they are sending. This is a critical action.`});
    if (!r) return;
    try { App.applied(await App.api("/api/cranes/enable", {json: {cranes, enabled, all, ...r}})); App.poll(); this.refreshView(); } catch (e) { App.err(e); }
  },

  async changeVersion(cranes, suggestId, size) {
    await this.loadVersions();
    const c0 = App.live.cranes.find(c => c.crane === cranes[0]) || {};
    const term = c0.program || c0.expected_program || App.expectedProgram(cranes[0], c0.terminal);
    const m = App.modal({title: `Change packet version · ${h(cranes.join(", "))}`, html: `
      ${size ? `<div class="confirm-box">The crane sends <b>${size}-byte</b> packets. ${suggestId ? "The matching version is pre-selected." : "No version has exactly this size."}</div>` : ""}
      <label class="f">Version<select id="cvSel">${this.versionOptions(term, suggestId)}</select></label>
      <div class="actions"><button class="btn" id="cvNo">Cancel</button><button class="btn primary" id="cvGo">Continue…</button></div>`});
    $("#cvNo", m.el).onclick = () => m.close();
    $("#cvGo", m.el).onclick = async () => {
      const vid = +$("#cvSel", m.el).value;
      if (!vid) return;
      const v = this.versions.find(x => x.id === vid);
      m.close();
      const r = await App.confirm({title: "Change packet version", danger: true, okText: "Change version",
        summary: `<b>${h(cranes.join(", "))}</b> will be decoded with <b>${h(v.program)} ${h(v.name)}</b> (${v.packet_size} bytes, ${v.field_count} fields).<br>Only these cranes are reloaded in the collector; the others keep running.`});
      if (!r) return;
      try { App.applied(await App.api("/api/cranes/version", {json: {cranes, version_id: vid, ...r}})); App.poll(); this.refreshView(); } catch (e) { App.err(e); }
    };
  },

  async refreshCollector() {
    const pend = (App.live && App.live.pending) || [];
    const r = await App.confirm({title: "Refresh the collector", okText: "Refresh",
      summary: `The collector reloads the saved settings. ${pend.length ? `Cranes with changes: <b>${h(pend.join(", "))}</b>.` : "No cranes are waiting for changes."}<br>Only changed cranes restart; all others keep collecting without a gap.`});
    if (!r) return;
    try { App.applied(await App.api("/api/collector/refresh", {json: r})); App.poll(); } catch (e) { App.err(e); }
  },

  refreshView() { if (App.view === "config") App.views.config.renderSub(); },

  /* ── crane form ── */
  async editCrane(crane) {
    await this.loadVersions();
    App.closeCrane && App.closeCrane();
    const all = await App.api("/api/cranes");
    const c = crane ? all.find(x => x.crane === crane) : {terminal: App.terminal || "T2", crane: "", port: "", ip: "", version_id: "", enabled: 1, notes: ""};
    const terms = Object.keys(App.meta.terminals);
    const m = App.modal({title: crane ? `Edit crane ${h(crane)}` : "Add crane", html: `
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <label class="f">Terminal<select id="cfT">${terms.map(t => `<option ${t === c.terminal ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <label class="f">Crane ID<input id="cfC" value="${h(c.crane)}" placeholder="e.g. E208" maxlength="4" style="text-transform:uppercase"></label>
        <label class="f">UDP port<input id="cfP" value="${h(c.port || "")}" inputmode="numeric"><span class="small" id="cfRule"></span></label>
        <label class="f">Registered PLC IP (required)<input id="cfI" value="${h(c.ip || "")}" placeholder="10.32.20.x"></label>
        <label class="f">Program · packet version<select id="cfV">${this.versionOptions(c.program || App.expectedProgram(c.crane, c.terminal), c.version_id)}</select><span class="small" id="cfProg"></span></label>
        <label class="f">Writing to InfluxDB<select id="cfE"><option value="1">ON - collect and write</option><option value="0" ${c.enabled ? "" : "selected"}>OFF - listen only</option></select></label>
      </div>
      <label class="f" style="margin-top:8px">Notes<input id="cfN" value="${h(c.notes || "")}"></label>
      <ul class="errlist" id="cfErr"></ul><ul class="warnlist" id="cfWarn"></ul>
      <div class="small muted">The collector only accepts packets from the registered IP on this port. Packets from any other IP are blocked and raise an IP-conflict alarm.</div>
      <div class="actions"><button class="btn" id="cfNo">Cancel</button><button class="btn primary" id="cfSave">Save…</button></div>`});
    const val = () => ({terminal: $("#cfT", m.el).value, crane: $("#cfC", m.el).value.trim().toUpperCase(), port: $("#cfP", m.el).value.trim(), ip: $("#cfI", m.el).value.trim(),
      version_id: $("#cfV", m.el).value, enabled: $("#cfE", m.el).value === "1", notes: $("#cfN", m.el).value, original: crane || null});
    let tm;
    const check = () => { clearTimeout(tm); tm = setTimeout(async () => {
      const v = val();
      const r = await App.api("/api/cranes/validate", {json: v});
      $("#cfErr", m.el).innerHTML = r.errors.map(e => `<li>${h(e)}</li>`).join("");
      $("#cfWarn", m.el).innerHTML = r.warnings.map(e => `<li>${h(e)}</li>`).join("");
      $("#cfRule", m.el).innerHTML = r.rule_port ? `port rule: <b>${r.rule_port}</b>${String(r.rule_port) !== v.port ? ` <a href="#" id="cfUse">use it</a>` : " ✓"}` : "";
      const u = $("#cfUse", m.el); if (u) u.onclick = e => { e.preventDefault(); $("#cfP", m.el).value = r.rule_port; check(); };
      $("#cfSave", m.el).disabled = r.errors.length > 0;
    }, 250); };
    $$("input,select", m.el).forEach(x => x.addEventListener("input", check));
    const reprog = () => {
      const p = App.expectedProgram($("#cfC", m.el).value.trim().toUpperCase(), $("#cfT", m.el).value);
      $("#cfProg", m.el).textContent = p ? `expected program: ${p}` : "";
      let cur = $("#cfV", m.el).value;
      if (!crane && !cur) { const own = (this.versions || []).filter(v => v.program === p); if (own.length) cur = own[own.length - 1].id; }   // newest version of that program
      $("#cfV", m.el).innerHTML = this.versionOptions(p, cur);
    };
    $("#cfT", m.el).onchange = () => { reprog(); check(); };
    $("#cfC", m.el).addEventListener("change", () => { reprog(); check(); });
    reprog();
    check();
    $("#cfNo", m.el).onclick = () => m.close();
    $("#cfSave", m.el).onclick = async () => {
      const v = val();
      const ver = this.versions.find(x => x.id == v.version_id) || {};
      const ch = [];
      if (crane) {
        if (String(c.port) !== v.port) ch.push(`port ${c.port} → <b>${h(v.port)}</b>`);
        if (c.ip !== v.ip) ch.push(`IP ${h(c.ip || "-")} → <b>${h(v.ip)}</b>`);
        if (c.version_id != v.version_id) ch.push(`version ${h(c.version_name)} → <b>${h(ver.name)}</b>`);
        if (!!c.enabled !== v.enabled) ch.push(`writing ${v.enabled ? "<b>ON</b>" : "<b>OFF</b>"}`);
        if (c.terminal !== v.terminal) ch.push(`terminal ${c.terminal} → <b>${v.terminal}</b>`);
        if (crane !== v.crane) ch.push(`crane ID ${crane} → <b>${h(v.crane)}</b>`);
        if ((c.notes || "") !== v.notes) ch.push("notes");
      }
      const critical = crane && ch.some(x => /port|IP|version|writing|crane ID/.test(x));
      const r = await App.confirm({title: crane ? `Save changes to ${crane}` : `Add crane ${v.crane}`, danger: critical, typed: critical && !v.enabled ? v.crane : null,
        summary: crane ? (ch.length ? `<ul>${ch.map(x => `<li>${x}</li>`).join("")}</ul>Only ${h(v.crane)} is reloaded in the collector.` : "No changes.") :
          `<b>${h(v.crane)}</b> (${h(v.terminal)}) · port <b>${h(v.port)}</b> · IP <b>${h(v.ip)}</b> · ${h(ver.program || "")} ${h(ver.name || "")} · writing ${v.enabled ? "ON" : "OFF"}`});
      if (!r) return;
      try { App.applied(await App.api("/api/cranes", {json: {...v, ...r}})); m.close(); App.poll(); this.refreshView(); } catch (e) { App.err(e); }
    };
  },

  async removeCrane(crane) {
    const r = await App.confirm({title: `Remove ${crane} from the register`, danger: true, typed: crane, okText: "Remove",
      summary: `<b>${h(crane)}</b> is removed from the platform and the collector stops listening on its port. Its data already in InfluxDB is <b>not</b> touched.`});
    if (!r) return;
    try { App.applied(await App.api("/api/cranes/" + crane, {method: "DELETE", json: r})); App.poll(); this.refreshView(); } catch (e) { App.err(e); }
  },

  /* ── Excel import ── */
  importDialog() {
    const m = App.modal({title: "Import cranes from Excel", wide: true, html: `
      <div class="row"><input type="file" id="imFile" accept=".xlsx,.xlsm"><label class="chk"><input type="checkbox" id="imRemove"> Remove cranes that are not in the file</label>
        <button class="btn primary" id="imPrev">Check file / preview</button><a class="btn ghost" href="/api/cranes/template">Download template</a></div>
      <div class="small muted" style="margin-top:6px">Columns: Terminal, Crane, Port, IP, Version, Enabled, Notes. Nothing changes until you confirm the preview.</div>
      <div id="imOut" style="margin-top:12px"></div>`});
    $("#imPrev", m.el).onclick = async () => {
      const f = $("#imFile", m.el).files[0];
      if (!f) return App.toast("Choose a file");
      const fd = new FormData(); fd.append("file", f); fd.append("remove_missing", $("#imRemove", m.el).checked ? "1" : "0");
      let pv;
      try { pv = await App.api("/api/cranes/import/preview", {method: "POST", body: fd}); } catch (e) { return App.err(e); }
      const S = pv.summary;
      $("#imOut", m.el).innerHTML = `
        <div class="row">${badge("new", S.new + " new")}${badge("changed", S.changed + " changed")}${badge("unchanged", S.unchanged + " unchanged")}${badge("problem", S.problem + " with problems")}${S.removed ? badge("error", S.removed + " to remove") : ""}</div>
        <div class="tbl-wrap" style="max-height:48vh;margin-top:8px"><table class="t"><tr><th>Status</th><th>Crane</th><th>Terminal</th><th>Port</th><th>IP</th><th>Program · version</th><th>Writing</th><th>Changes / problems</th><th>Row</th></tr>
        ${pv.items.map(i => `<tr><td>${badge(i.status)}</td><td><b>${h(i.crane)}</b></td><td>${h(i.new.terminal)}</td><td>${h(i.new.port ?? "")}</td><td class="mono">${h(i.new.ip || "")}</td><td>${h((i.new.program || "") + " " + (i.new.version_name || ""))}</td><td>${i.new.enabled ? "ON" : "OFF"}</td>
          <td class="small">${i.errors.map(e => `<div style="color:var(--danger)">✕ ${h(e)}</div>`).join("")}${i.warnings.map(e => `<div style="color:var(--warn)">⚠ ${h(e)}</div>`).join("")}${i.changes.map(e => `<div>${h(e)}</div>`).join("")}</td>
          <td class="small muted">${h(i.sheet)}:${i.row}</td></tr>`).join("")}
        ${pv.removed.map(c => `<tr><td>${badge("error", "remove")}</td><td><b>${h(c)}</b></td><td colspan="7" class="small">not in the file</td></tr>`).join("")}</table></div>
        ${S.problem ? `<label class="chk" style="margin-top:8px"><input type="checkbox" id="imSkip"> Apply the good rows and skip the rows with problems</label>` : ""}
        <div class="actions"><button class="btn" id="imCancel">Cancel</button><button class="btn primary" id="imApply" ${S.new + S.changed + S.removed ? "" : "disabled"}>Apply ${S.new + S.changed} change(s)…</button></div>`;
      $("#imCancel", m.el).onclick = () => m.close();
      $("#imApply", m.el).onclick = async () => {
        const skip = $("#imSkip", m.el) ? $("#imSkip", m.el).checked : false;
        if (S.problem && !skip) return App.toast("Fix the problem rows, or tick 'apply the good rows'.", "err");
        const r = await App.confirm({title: "Apply the Excel import", danger: S.changed + S.removed > 0, typed: S.removed ? "IMPORT" : null, okText: "Apply",
          summary: `<ul><li>${S.new} new crane(s)</li><li>${S.changed} changed crane(s)</li>${S.removed ? `<li><b>${S.removed} removed</b></li>` : ""}${S.problem ? `<li>${S.problem} row(s) with problems skipped</li>` : ""}</ul>Only the affected cranes are reloaded in the collector. A backup of the current configuration is saved first.`});
        if (!r) return;
        try { const res = await App.api("/api/cranes/import/apply", {json: {token: pv.token, skip_problems: skip, ...r}}); App.applied(res); m.close(); App.poll(); this.refreshView(); } catch (e) { App.err(e); }
      };
    };
  },
};

/* ── Configuration view ── */
App.views.config = {
  sub: "cranes", sel: new Set(),
  render(el, sub) {
    if (sub) this.sub = sub;
    el.innerHTML = `<div class="subtabs seg" id="cfgTabs">${[["cranes", "Cranes"], ["versions", "Packet versions"], ["collector", "Collector"], ["notify", "Notifications"], ["influx", "InfluxDB"], ["system", "System"]].map(([k, t]) => `<button data-s="${k}" class="${this.sub === k ? "on" : ""}">${t}</button>`).join("")}</div><div id="cfgBody"></div>`;
    $$("#cfgTabs button").forEach(b => b.onclick = () => { this.sub = b.dataset.s; history.replaceState(null, "", "#config/" + this.sub); $$("#cfgTabs button").forEach(x => x.classList.toggle("on", x === b)); this.renderSub(); });
    this.renderSub();
  },
  renderSub() {
    const b = $("#cfgBody");
    if (!b) return;
    ({cranes: () => this.cranes(b), versions: () => Versions.render(b), collector: () => this.collector(b), notify: () => this.notify(b), influx: () => this.influx(b), system: () => this.system(b)})[this.sub]();
  },
  update(live) { if (this.sub === "collector" && $("#colBox")) this.collectorBox(live); if (this.sub === "cranes" && $("#crTable")) this.crStates(live); },

  async cranes(b) {
    await Config.loadVersions();
    const list = await App.api("/api/cranes" + (App.terminal ? "?terminal=" + App.terminal : ""));
    this.sel = new Set([...this.sel].filter(c => list.some(x => x.crane === c)));
    b.innerHTML = `<div class="row" style="margin-bottom:10px"><h2 style="margin:0">Crane register ${App.terminal ? "· " + App.terminal : ""}</h2>
        <button class="btn primary" id="crAdd">+ Add crane</button><button class="btn" id="crImp">Import Excel…</button><a class="btn" href="/api/cranes/template">Download template</a>
        <span class="right"></span><span class="small muted" id="crSelN"></span>
        <button class="btn" id="crStart">▶ Start writing</button><button class="btn danger" id="crStop">■ Stop writing</button><button class="btn" id="crVer">Change version</button></div>
      <div class="tbl-wrap"><table class="t" id="crTable"><tr><th><input type="checkbox" id="crAll"></th><th>Crane</th><th>Terminal</th><th class="num">Port</th><th>Registered IP</th><th>Program · version</th><th>Writing</th><th>Live state</th><th>Notes</th><th></th></tr>
      ${list.map(c => `<tr data-c="${h(c.crane)}"><td><input type="checkbox" data-sel="${h(c.crane)}" ${this.sel.has(c.crane) ? "checked" : ""}></td><td><b>${h(c.crane)}</b></td><td>${h(c.terminal)}</td>
        <td class="num">${c.port}${c.rule_warning ? ` <span class="warnicon" title="${h(c.rule_warning)}">⚠</span>` : ""}</td><td class="mono">${h(c.ip) || `<span style="color:var(--danger)">missing</span>`}</td>
        <td>${h(c.program || "")} ${h(c.version_name || "–")}${c.program && c.program !== App.expectedProgram(c.crane, c.terminal) ? ` <span class="warnicon" title="expected program: ${h(App.expectedProgram(c.crane, c.terminal))}">⚠</span>` : ""}</td><td>${c.enabled ? badge("OK", "ON") : badge("OFF", "OFF")}</td><td class="st" data-st="${h(c.crane)}"></td><td class="small muted">${h(c.notes || "")}</td>
        <td style="white-space:nowrap"><button class="btn sm" data-ed="${h(c.crane)}">Edit</button> <button class="btn sm" data-info="${h(c.crane)}">Details</button> <button class="btn sm ghost" data-rm="${h(c.crane)}">Remove</button></td></tr>`).join("") ||
        `<tr><td colspan="10" class="empty">No cranes yet. <b>Import Excel</b> (download the template - it is pre-filled with the cranes and ports from your current collectors; fill in the IPs) or <b>Add crane</b>.</td></tr>`}</table></div>
      <div class="small muted" style="margin-top:6px">⚠ = the port does not follow the terminal's port rule (advisory only - your list is the master). Every change is applied to the collector right away; only the affected cranes reload.</div>`;
    const selN = () => { $("#crSelN").textContent = this.sel.size ? `${this.sel.size} selected` : "select cranes for bulk actions"; };
    selN();
    $("#crAll").onchange = e => { $$("[data-sel]").forEach(x => { x.checked = e.target.checked; e.target.checked ? this.sel.add(x.dataset.sel) : this.sel.delete(x.dataset.sel); }); selN(); };
    $$("[data-sel]").forEach(x => x.onchange = () => { x.checked ? this.sel.add(x.dataset.sel) : this.sel.delete(x.dataset.sel); selN(); });
    $("#crAdd").onclick = () => Config.editCrane(null);
    $("#crImp").onclick = () => Config.importDialog();
    const need = () => { if (!this.sel.size) { App.toast("Select cranes first (tick boxes)"); return null; } return [...this.sel]; };
    $("#crStart").onclick = () => { const s = need(); if (s) Config.setWriting(s, true); };
    $("#crStop").onclick = () => { const s = need(); if (s) Config.setWriting(s, false, s.length === list.length && list.length > 1); };
    $("#crVer").onclick = () => { const s = need(); if (s) Config.changeVersion(s); };
    $$("[data-ed]").forEach(x => x.onclick = () => Config.editCrane(x.dataset.ed));
    $$("[data-rm]").forEach(x => x.onclick = () => Config.removeCrane(x.dataset.rm));
    $$("[data-info]").forEach(x => x.onclick = () => App.openCrane(x.dataset.info));
    if (App.live) this.crStates(App.live);
  },
  crStates(live) { $$("#crTable [data-st]").forEach(td => { const c = live.cranes.find(x => x.crane === td.dataset.st); td.innerHTML = c ? badge(c.state) : ""; }); },

  collector(b) {
    b.innerHTML = `<h2>Collector service</h2><div id="colBox"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="colRef">⟳ Refresh collector</button><button class="btn danger" id="colRestart">Restart collector service…</button></div>
      <div class="small muted" style="margin-top:8px">Refresh reloads the saved settings - only changed cranes restart, all others keep collecting. Restart stops and starts the whole Windows service (a few seconds without collection; queued data is flushed or buffered first). The platform's watchdog also restarts the service by itself if it stops answering.</div>`;
    $("#colRef").onclick = () => Config.refreshCollector();
    $("#colRestart").onclick = async () => {
      const r = await App.confirm({title: "Restart the collector service", danger: true, typed: "RESTART", okText: "Restart", summary: "All cranes stop collecting for a few seconds while the service restarts."});
      if (!r) return;
      try { const x = await App.api("/api/service/restart_collector", {json: r}); App.toast(h(x.message), "ok"); } catch (e) { App.err(e); }
    };
    if (App.live) this.collectorBox(App.live);
  },
  collectorBox(live) {
    const c = live.collector, w = live.writer || {};
    $("#colBox").innerHTML = `<div class="tiles">
      <div class="tile"><div class="v">${c.up ? "Running" : "DOWN"}</div><div class="l">${c.up ? `pid ${c.pid} · since ${App.fmtTime(c.started)}` : h(c.error || "")}</div></div>
      <div class="tile"><div class="v">${c.listeners ?? "–"}</div><div class="l">UDP listeners ${c.threads_ok === false ? "(one not alive!)" : ""}</div></div>
      <div class="tile"><div class="v">${w.healthy === true ? "OK" : w.healthy === false ? "FAILING" : "–"}</div><div class="l">InfluxDB writes${w.last_ok ? " · last OK " + App.ago(w.last_ok) : ""}</div></div>
      <div class="tile"><div class="v">${App.num(w.written_total || 0)}</div><div class="l">points written since start</div></div>
      <div class="tile"><div class="v">${App.num(w.buffered || 0)}</div><div class="l">in outage buffer (${((w.buffer_bytes || 0) / 1e6).toFixed(1)} MB)</div></div>
      <div class="tile"><div class="v">${App.num(w.rejected_total || 0)}</div><div class="l">points rejected by InfluxDB</div></div>
      <div class="tile"><div class="v">${live.pending.length}</div><div class="l">cranes waiting for refresh${live.pending.length ? ": " + h(live.pending.join(", ")) : ""}</div></div>
      <div class="tile"><div class="v">${c.last_reload ? App.fmtTime(c.last_reload, true, false) : "–"}</div><div class="l">last reload</div></div></div>
      ${w.last_error ? `<div class="confirm-box" style="margin-top:10px"><b>Last InfluxDB error</b> (${App.fmtTime(w.last_error_ts)}): ${h(w.last_error)}</div>` : ""}`;
  },

  async notify(b) {
    const s = await App.api("/api/settings");
    const types = ["IP_CONFLICT", "WRONG_SIZE", "INFLUX_WRITE", "SERVICE_DOWN", "PORT_BUSY", "PARSE_ERROR", "DISK"];
    b.innerHTML = `<div class="card" style="max-width:720px"><h2>Notifications</h2>
      <label class="chk"><input type="checkbox" id="nSound" ${s.sound ? "checked" : ""}> Sound in the platform when a new alarm starts</label><br>
      <label class="chk"><input type="checkbox" id="nPop" ${s.desktop_popups ? "checked" : ""}> Windows desktop pop-ups on the collector PC (notifier, starts at sign-in)</label>
      <h4 style="margin-top:12px">Alarm types that pop up</h4><div class="col">${types.map(t => `<label class="chk"><input type="checkbox" data-t="${t}" ${s.popup_types.includes(t) ? "checked" : ""}> ${t.replace(/_/g, " ")}</label>`).join("")}</div>
      <p class="small muted">"Idle / no data" is never an alarm: a PLC only sends while the crane is in Auto, without manual intervention, with a work order active. The banner, sound and alarm list are always on in the platform; the mute button 🔊 at the top mutes only this browser.</p>
      <div class="row"><button class="btn" id="nTest">Test sound</button><button class="btn primary" id="nSave">Save…</button></div></div>`;
    $("#nTest").onclick = () => { const m = App.muted; App.muted = false; App.beep(3); App.muted = m; };
    $("#nSave").onclick = async () => {
      const r = await App.confirm({title: "Save notification settings", summary: "Notification settings are updated."});
      if (!r) return;
      try { await App.api("/api/settings", {json: {sound: $("#nSound").checked, desktop_popups: $("#nPop").checked, popup_types: $$("[data-t]").filter(x => x.checked).map(x => x.dataset.t), ...r}}); App.meta.sound = $("#nSound").checked; App.toast("Saved", "ok"); } catch (e) { App.err(e); }
    };
  },

  async influx(b) {
    const s = await App.api("/api/settings");
    b.innerHTML = `<div class="card" style="max-width:720px"><h2>InfluxDB</h2>
      <p class="small muted">Nothing changes in InfluxDB: same bucket, measurement <b>${h(s.influx_measurement)}</b>, tag <b>crane_id</b> and field names as the old scripts.</p>
      <div class="grid" style="grid-template-columns:2fr 1fr 1fr"><label class="f">URL<input id="iU" value="${h(s.influx_url)}"></label><label class="f">Organisation<input id="iO" value="${h(s.influx_org)}"></label><label class="f">Bucket<input id="iB" value="${h(s.influx_bucket)}"></label></div>
      <p>Token: ${s.token_present ? badge("ok", "influx_token.txt found") : badge("error", "missing - create influx_token.txt next to app.py with the token on one line")}<br><span class="small muted">The token is never shown here and never stored in the code. Keep influx_token.txt out of GitHub.</span></p>
      <div class="row"><button class="btn" id="iTest">Test connection</button><button class="btn primary" id="iSave">Save…</button><span id="iRes" class="small"></span></div></div>`;
    $("#iTest").onclick = async () => {
      $("#iRes").textContent = "testing…";
      const r = await App.api("/api/influx/test", {json: {influx_url: $("#iU").value, influx_org: $("#iO").value, influx_bucket: $("#iB").value}});
      $("#iRes").innerHTML = r.ok ? `${badge("ok", "reachable")} ${h(r.message)} · bucket ${h(r.bucket || "")}` : `${badge("error", "failed")} ${h(r.message)}`;
    };
    $("#iSave").onclick = async () => {
      const r = await App.confirm({title: "Change the InfluxDB connection", danger: true, okText: "Save",
        summary: `New connection: <b>${h($("#iU").value)}</b> · org <b>${h($("#iO").value)}</b> · bucket <b>${h($("#iB").value)}</b>.<br>The collector service uses it after a restart (Collector tab → Restart).`});
      if (!r) return;
      try { await App.api("/api/settings", {json: {influx_url: $("#iU").value.trim(), influx_org: $("#iO").value.trim(), influx_bucket: $("#iB").value.trim(), ...r}}); App.toast("Saved. Restart the collector service to use it.", "ok"); } catch (e) { App.err(e); }
    };
  },

  async system(b) {
    b.innerHTML = `<div class="grid" style="grid-template-columns:1fr 1fr">
      <div class="card"><div class="row"><h2 style="margin:0">Self-test</h2><span class="right"></span><button class="btn sm" id="syRun">Run again</button></div><div id="syTest" style="margin-top:8px"></div></div>
      <div class="card"><h2>Terminals &amp; yard</h2><div id="syTerm"></div></div></div>
      <div class="card" style="margin-top:14px"><h2>Configuration backups</h2><p class="small muted">A backup is saved automatically before every change (last 50 kept).</p><div class="tbl-wrap" style="max-height:300px" id="syBk"></div></div>
      <div class="card" style="margin-top:14px"><h2>Change log</h2><div class="tbl-wrap" style="max-height:420px" id="syAudit"></div></div>`;
    const test = async () => {
      $("#syTest").innerHTML = `<div class="muted">checking…</div>`;
      const r = await App.api("/api/selftest");
      $("#syTest").innerHTML = `<table class="t">${r.map(c => `<tr><td>${c.level === "ok" ? "✅" : c.level === "warning" ? "⚠️" : "❌"}</td><td><b>${h(c.name)}</b></td><td class="small">${h(c.detail)}</td></tr>`).join("")}</table>`;
    };
    $("#syRun").onclick = test;
    test();
    const s = await App.api("/api/settings");
    $("#syTerm").innerHTML = `<table class="t"><tr><th>Terminal</th><th>Name</th><th>Port base</th><th>Lanes</th><th>Cranes per lane</th></tr>${Object.entries(s.terminals).map(([k, t]) => `<tr data-t="${k}"><td><b>${k}</b></td><td><input data-k="name" value="${h(t.name)}" style="width:110px"></td><td><input data-k="port_base" value="${t.port_base}" style="width:70px"></td><td><input data-k="lanes" value="${h(t.lanes)}" style="width:80px"></td><td><input data-k="lane_counts" value="${h(Object.entries(t.lane_counts || {}).map(([l, n]) => l + "=" + n).join(" "))}" style="width:190px" title="e.g. A=14 B=14 C=12"></td></tr>`).join("")}</table>
      <p class="small muted">Program per crane (Retrofit / New / ZPMC) - used to suggest versions and flag mismatches:<br>${Object.entries(s.program_rules || {}).map(([t, r]) => `<b>${t}</b>: ${h(r.default || "")}${r.lanes ? Object.entries(r.lanes).map(([l, p]) => `, lane ${l} = ${p}`).join("") : ""}${r.cranes ? Object.entries(r.cranes).map(([c, p]) => `, ${c} = ${p}`).join("") : ""}`).join(" · ")} (edit program_rules in settings.json)</p>
      <p class="small muted">Port rule: port = base + (crane number − 1) × number of lanes + lane position (A = 1). Used only to flag inconsistencies.</p>
      <div class="row"><label class="f">Yard gantry min (m)<input id="yMin" value="${s.yard.gantry_min}" style="width:80px"></label><label class="f">gantry max<input id="yMax" value="${s.yard.gantry_max}" style="width:80px"></label><label class="f">trolley max<input id="yT" value="${s.yard.trolley_max}" style="width:70px"></label><label class="f">hoist max<input id="yH" value="${s.yard.hoist_max}" style="width:70px"></label></div>
      <button class="btn primary" id="sySave" style="margin-top:8px">Save…</button>`;
    $("#sySave").onclick = async () => {
      const terminals = {};
      $$("#syTerm tr[data-t]").forEach(tr => {
        const v = k => $(`[data-k=${k}]`, tr).value;
        const lc = {};
        v("lane_counts").toUpperCase().split(/[\s,;]+/).forEach(p => { const m = p.match(/^([A-Z])=(\d+)$/); if (m) lc[m[1]] = +m[2]; });
        terminals[tr.dataset.t] = {name: v("name"), port_base: +v("port_base"), lanes: v("lanes").toUpperCase().replace(/[^A-Z]/g, ""), lane_counts: lc};
      });
      const yard = {gantry_min: +$("#yMin").value, gantry_max: +$("#yMax").value, trolley_max: +$("#yT").value, hoist_max: +$("#yH").value};
      const r = await App.confirm({title: "Save terminal settings", summary: "Terminal names, port rules and yard scale are updated."});
      if (!r) return;
      try { await App.api("/api/settings", {json: {terminals, yard, ...r}}); App.meta = await App.api("/api/meta"); App.toast("Saved", "ok"); } catch (e) { App.err(e); }
    };
    const bk = await App.api("/api/backups");
    $("#syBk").innerHTML = `<table class="t"><tr><th>Saved</th><th>Before</th><th class="num">Cranes</th><th class="num">Versions</th><th></th></tr>${bk.map(x => `<tr><td class="small">${App.fmtTime(x.ts)}</td><td class="small">${h(x.reason)}</td><td class="num">${x.cranes}</td><td class="num">${x.versions}</td><td><button class="btn sm" data-f="${h(x.file)}">Restore…</button></td></tr>`).join("") || `<tr><td class="empty">none yet</td></tr>`}</table>`;
    $$("#syBk [data-f]").forEach(x => x.onclick = async () => {
      const r = await App.confirm({title: "Restore a configuration backup", danger: true, typed: "RESTORE", okText: "Restore",
        summary: `The crane register and packet versions go back to the state saved at <b>${h(x.closest("tr").cells[0].textContent)}</b>. The current state is backed up first.`});
      if (!r) return;
      try { App.applied(await App.api("/api/backups/restore", {json: {file: x.dataset.f, ...r}})); this.renderSub(); } catch (e) { App.err(e); }
    });
    const au = await App.api("/api/audit");
    $("#syAudit").innerHTML = `<table class="t"><tr><th>Time</th><th>Action</th><th>Target</th><th>Reason</th><th>Change</th></tr>${au.map(a => `<tr><td class="small" style="white-space:nowrap">${App.fmtTime(a.ts)}</td><td>${h(a.action)}</td><td><b>${h(a.target)}</b></td><td class="small">${h(a.reason)}</td><td class="small mono" style="max-width:420px;word-break:break-all">${h(diff(a.before, a.after))}</td></tr>`).join("") || `<tr><td class="empty">nothing yet</td></tr>`}</table>`;
    function diff(b1, a1) {
      try {
        const B = b1 ? JSON.parse(b1) : {}, A = a1 ? JSON.parse(a1) : {};
        if (!b1 && a1) return Object.entries(A).filter(([k]) => !["created", "updated"].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
        return Object.keys({...B, ...A}).filter(k => !["created", "updated"].includes(k) && JSON.stringify(B[k]) !== JSON.stringify(A[k])).map(k => `${k}: ${JSON.stringify(B[k])} → ${JSON.stringify(A[k])}`).join("; ");
      } catch (e) { return ""; }
    }
  },
};

/* ── Packet versions ── */
const Versions = {
  selected: null, editor: null,
  async render(b) {
    await Config.loadVersions();
    if (this.editor) return this.renderEditor(b);
    const vs = Config.versions;
    const byT = {};
    vs.forEach(v => (byT[v.program] = byT[v.program] || []).push(v));
    if (!this.selected || !vs.find(v => v.id === this.selected)) this.selected = (vs[0] || {}).id;
    b.innerHTML = `<div class="layout2"><div class="card col"><h2>Packet versions</h2>
        ${App.meta.programs.filter(t => byT[t]).concat(Object.keys(byT).filter(t => !App.meta.programs.includes(t))).map(t => `<h4>${h(t)} <span class="muted" style="text-transform:none;letter-spacing:0">· ${h(App.programWhere(t))}</span></h4>${byT[t].map(v => `<a href="#" class="row ${v.id === this.selected ? "sel" : ""}" data-v="${v.id}" style="text-decoration:none;color:inherit;padding:6px 8px;border-radius:6px;${v.id === this.selected ? "background:var(--tint-accent)" : ""}">
          <b>${h(v.name)}</b><span class="small muted">${v.packet_size} B · ${v.field_count} fields</span><span class="right badge">${v.cranes.length} crane${v.cranes.length === 1 ? "" : "s"}</span></a>`).join("")}`).join("")}
        <p class="small muted">A new version is always a copy of an existing one plus your new fields. Existing fields are locked so InfluxDB keeps the same field names and types.</p></div>
      <div id="vDetail" class="col"></div></div>`;
    $$("[data-v]", b).forEach(a => a.onclick = e => { e.preventDefault(); this.selected = +a.dataset.v; this.render(b); });
    if (this.selected) this.detail($("#vDetail"), this.selected);
  },

  pmap(fields, size, newNames = new Set(), hitSlots = new Set()) {
    const n = Math.ceil(size / 4);
    const slot = {};
    fields.forEach(f => {
      if (f.type === "BIT") { slot[f.word] = slot[f.word] || {name: "status word", group: "Status words"}; (slot[f.word].bits = slot[f.word].bits || []).push(f.name); if (newNames.has(f.name)) slot[f.word].isNew = true; return; }
      const len = f.type === "TEXT" ? Math.ceil(f.length / 4) : 1;
      for (let i = 0; i < len; i++) slot[+f.slot + i] = {...(slot[+f.slot + i] || {}), name: f.name, group: f.group, type: f.type, isNew: newNames.has(f.name)};
    });
    return `<div class="pmap">${Array.from({length: n}, (_, i) => { const s = slot[i]; return `<div class="${s ? "used" : ""} ${s && s.isNew ? "new" : ""} ${hitSlots.has(i) ? "hit" : ""}" style="${s ? `background:${GROUP_COLORS[s.group] || "#888"}` : ""}" title="slot ${i} (bytes ${i * 4}-${i * 4 + 3})${s ? ": " + s.name + (s.bits ? " · bits: " + s.bits.join(", ") : "") : ": spare"}">${i}</div>`; }).join("")}</div>
      <div class="legend">${[...new Set(fields.map(f => f.type === "BIT" ? "Status words" : f.group))].map(g => `<span><i class="dot" style="background:${GROUP_COLORS[g] || "#888"}"></i>${h(g)}</span>`).join("")}<span><i class="dot"></i>spare</span></div>`;
  },

  async detail(el, vid) {
    const v = await App.api("/api/versions/" + vid);
    const base = v.base_id ? Config.versions.find(x => x.id === v.base_id) : null;
    el.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">${h(v.program)} · ${h(v.name)}</h2><span class="badge">${v.packet_size} bytes · ${v.fields.length} fields</span>
        <span class="right"></span><button class="btn primary" id="vNew">+ New version from ${h(v.name)}</button><button class="btn" id="vAssign">Assign cranes…</button><button class="btn ghost" id="vDel">Delete</button></div>
      <p class="small muted">${h(v.notes || "")}${base ? ` · built from ${h(base.name)}` : ""} · created ${App.fmtTime(v.created)}</p>
      <p><b>Cranes running it:</b> ${v.cranes.length ? v.cranes.map(c => `<a href="#" data-c="${c}">${c}</a>`).join(", ") : "<span class='muted'>none</span>"}</p>
      <h3>Packet map</h3>${this.pmap(v.fields, v.packet_size)}
      <h3 style="margin-top:12px">Fields</h3><div class="tbl-wrap" style="max-height:52vh"><table class="t"><tr><th>#</th><th>Field (InfluxDB name)</th><th>Type</th><th>Slot / bit</th><th>Group</th><th>Unit</th><th>Description</th></tr>
      ${v.fields.map((f, i) => `<tr><td class="muted">${i + 1}</td><td><span class="lock">🔒</span> <b>${h(f.name)}</b></td><td>${f.type}</td><td>${f.type === "BIT" ? `slot ${f.word} bit ${f.bit}` : f.type === "TEXT" ? `slot ${f.slot} (${f.length} bytes)` : `slot ${f.slot}`}</td><td>${h(f.group)}</td><td>${h(f.unit || "")}</td><td class="small">${h(f.description || "")}</td></tr>`).join("")}</table></div></div>`;
    $$("[data-c]", el).forEach(a => a.onclick = e => { e.preventDefault(); App.openCrane(a.dataset.c); });
    $("#vNew").onclick = () => { this.editor = {base: v, program: v.program, name: this.nextName(v), notes: "", newFields: [], manualSize: null, assign: new Set(v.cranes)}; this.render($("#cfgBody")); };
    $("#vAssign").onclick = () => Config.changeVersion(prompt("Crane IDs to switch to " + v.name + " (comma separated):", "")?.split(",").map(s => s.trim().toUpperCase()).filter(Boolean) || [], v.id);
    $("#vDel").onclick = async () => {
      const r = await App.confirm({title: `Delete version ${v.name}`, danger: true, typed: v.name, okText: "Delete", summary: "Only possible when no crane runs it and no other version was built from it. Data in InfluxDB is not touched."});
      if (!r) return;
      try { await App.api("/api/versions/" + v.id, {method: "DELETE", json: r}); this.selected = null; this.render($("#cfgBody")); App.toast("Deleted", "ok"); } catch (e) { App.err(e); }
    };
  },
  nextName(v) {
    const m = v.name.match(/^v?(\d+)(?:\.(\d+))?$/);
    let cand = m ? `v${m[1]}.${(+(m[2] || 0)) + 1}` : v.name + "-new";
    while (Config.versions.some(x => x.program === v.program && x.name === cand)) { const k = cand.match(/(\d+)$/); cand = cand.replace(/(\d+)$/, String(+k[1] + 1)); }
    return cand;
  },

  /* ── editor for a new version ── */
  renderEditor(b) {
    const E = this.editor, base = E.base;
    const used = new Set(), dwords = base.fields.filter(f => f.type === "DWORD").map(f => f.slot);
    E.newFields.filter(f => f.type === "DWORD" && f.slot !== "").forEach(f => dwords.push(+f.slot));
    const all = () => base.fields.concat(E.newFields.map(f => ({...f})));
    const occupied = () => { const s = new Set(); all().forEach(f => { if (f.type === "BIT" || f.slot === "" || f.slot == null) return; const len = f.type === "TEXT" ? Math.ceil((+f.length || 4) / 4) : 1; for (let i = 0; i < len; i++) s.add(+f.slot + i); }); return s; };
    const nextFree = () => { const s = occupied(); let i = 0; const max = Math.max(...s); while (s.has(i)) i++; return i <= max ? i : max + 1; };
    const nextFreeEnd = () => Math.max(...occupied()) + 1;
    const freeBits = w => { const used2 = new Set(all().filter(f => f.type === "BIT" && +f.word === +w).map(f => +f.bit)); return Array.from({length: 32}, (_, i) => i).filter(i => !used2.has(i)); };
    const crs = (App.live ? App.live.cranes : []);
    const progOf = c => c.program || c.expected_program;
    const termCr = crs.filter(c => (c.expected_program || progOf(c)) === E.program).map(c => c.crane);
    const otherCr = crs.filter(c => (c.expected_program || progOf(c)) !== E.program).map(c => c.crane);
    b.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">New packet version · ${h(E.program)}</h2><span class="muted">based on <b>${h(base.name)}</b> (${base.packet_size} B, ${base.fields.length} locked fields)</span><span class="right"></span><button class="btn" id="veCancel">Cancel</button></div>
      <div class="grid" style="grid-template-columns:1fr 2fr 1fr;margin-top:10px">
        <label class="f">Version name<input id="veName" value="${h(E.name)}"></label>
        <label class="f">What changed (notes)<input id="veNotes" value="${h(E.notes)}" placeholder="e.g. added hoist brake temperature"></label>
        <label class="f">Packet size (bytes)<div class="row" style="gap:6px"><input id="veSize" style="width:90px" value="${E.manualSize || ""}" placeholder="auto"><span class="small muted" id="veAuto"></span></div></label></div>
      <h3 style="margin-top:14px">New fields</h3>
      <div class="small muted">Add one row per new PLC value. <b>Slot</b> = the index in the PLC BufferConvert array (4 bytes each). For a flag inside a status word choose type <b>BIT</b>, the status word and the bit number. Next free slot at the end: <b id="veFree"></b>.</div>
      <div class="tbl-wrap" style="margin-top:6px"><table class="t" id="veTable"><tr><th>Field name</th><th>Type</th><th>Slot / status word</th><th>Bit / length</th><th>Group</th><th>Unit</th><th>Description</th><th></th></tr>
      ${E.newFields.map((f, i) => `<tr class="newrow" data-i="${i}">
        <td><input data-k="name" value="${h(f.name)}" placeholder="e.g. HoistBrakeTemp" style="width:170px"></td>
        <td><select data-k="type">${["REAL", "DINT", "DWORD", "BIT", "TEXT"].map(t => `<option ${t === f.type ? "selected" : ""}>${t}</option>`).join("")}</select></td>
        <td>${f.type === "BIT" ? `<select data-k="word">${[...new Set(dwords)].map(w => `<option value="${w}" ${+f.word === +w ? "selected" : ""}>slot ${w} (${h((all().find(x => x.type === "DWORD" && +x.slot === +w) || {}).name || "new word")})</option>`).join("")}</select>` : `<input data-k="slot" value="${h(f.slot)}" style="width:60px" inputmode="numeric">`}</td>
        <td>${f.type === "BIT" ? `<input data-k="bit" value="${h(f.bit)}" style="width:50px"> <span class="small muted">free: ${freeBits(f.word).slice(0, 8).join(", ")}${freeBits(f.word).length > 8 ? "…" : ""}</span>` : f.type === "TEXT" ? `<input data-k="length" value="${h(f.length)}" style="width:50px"> bytes` : `<span class="muted small">4 bytes</span>`}</td>
        <td><select data-k="group">${App.meta.groups.map(g => `<option ${g === f.group ? "selected" : ""}>${h(g)}</option>`).join("")}</select></td>
        <td><input data-k="unit" value="${h(f.unit || "")}" style="width:60px"></td>
        <td><input data-k="description" value="${h(f.description || "")}" style="width:220px"></td>
        <td><button class="btn ghost sm" data-del="${i}">✕</button></td></tr>`).join("") || `<tr><td colspan="8" class="empty">No new fields yet.</td></tr>`}</table></div>
      <div class="row" style="margin-top:8px"><button class="btn" id="veAdd">+ Add value (REAL/DINT)</button><button class="btn" id="veAddBit">+ Add flag (BIT)</button><button class="btn" id="veAddText">+ Add text</button></div>
      <ul class="errlist" id="veErr"></ul>
      <h3 style="margin-top:14px">Packet map</h3><div id="veMap"></div>
      <details style="margin-top:10px"><summary><b>Locked fields from ${h(base.name)}</b> (${base.fields.length})</summary><div class="tbl-wrap" style="max-height:300px;margin-top:6px"><table class="t">${base.fields.map(f => `<tr><td>🔒 ${h(f.name)}</td><td>${f.type}</td><td>${f.type === "BIT" ? `slot ${f.word} bit ${f.bit}` : `slot ${f.slot}`}</td><td>${h(f.group)}</td></tr>`).join("")}</table></div></details>
      <h3 style="margin-top:14px">Test on live data</h3>
      <div class="row"><select id="veCrane">${crs.map(c => `<option ${c.crane === (E.testCrane || termCr[0]) ? "selected" : ""}>${c.crane}</option>`).join("")}</select><button class="btn" id="veTest">Decode the latest packet with this new version</button><label class="chk small"><input type="checkbox" id="veAllF"> show all fields</label></div>
      <div id="veTestOut" style="margin-top:8px"></div>
      <h3 style="margin-top:14px">Cranes that will run ${h(E.name)}</h3>
      <div class="row small"><button class="btn sm" id="veAllT">All ${h(E.program)} cranes</button><button class="btn sm" id="veNone">None</button><span class="muted">(you can also assign later)</span></div>
      <div class="chips" style="margin-top:6px">${termCr.map(c => `<button class="chip ${E.assign.has(c) ? "on" : ""}" data-a="${c}">${c}</button>`).join("")}</div>
      ${otherCr.length ? `<details style="margin-top:6px"><summary class="small">Cranes that normally run another program</summary><div class="chips" style="margin-top:6px">${otherCr.map(c => `<button class="chip ${E.assign.has(c) ? "on" : ""}" data-a="${c}">${c}</button>`).join("")}</div></details>` : ""}
      <div class="actions"><button class="btn" id="veCancel2">Cancel</button><button class="btn primary" id="veSave">Save version &amp; apply…</button></div></div>`;
    const rerender = () => this.renderEditor(b);
    $("#veCancel").onclick = $("#veCancel2").onclick = () => { if (!E.newFields.length || confirm("Discard this new version?")) { this.editor = null; this.render(b); } };
    $("#veName").oninput = e => E.name = e.target.value;
    $("#veNotes").oninput = e => E.notes = e.target.value;
    $("#veSize").oninput = e => { E.manualSize = e.target.value.trim() || null; this.validate(); };
    $("#veFree").textContent = nextFreeEnd();
    const groupOf = (n, t) => t === "BIT" ? "Crane state" : t === "DINT" ? "Job & automation" : t === "TEXT" ? "Text" : "Other";
    $("#veAdd").onclick = () => { E.newFields.push({name: "", type: "REAL", slot: nextFreeEnd(), group: "Other", unit: "", description: ""}); rerender(); };
    $("#veAddBit").onclick = () => { const w = dwords[dwords.length - 1]; E.newFields.push({name: "", type: "BIT", word: w, bit: freeBits(w)[0] ?? 0, group: "Crane state", unit: "", description: ""}); rerender(); };
    $("#veAddText").onclick = () => { E.newFields.push({name: "", type: "TEXT", slot: nextFreeEnd(), length: 8, strip: "both", group: "Text", unit: "", description: ""}); rerender(); };
    $$("#veTable [data-del]").forEach(x => x.onclick = () => { E.newFields.splice(+x.dataset.del, 1); rerender(); });
    $$("#veTable tr[data-i]").forEach(tr => {
      const f = E.newFields[+tr.dataset.i];
      $$("[data-k]", tr).forEach(inp => {
        inp.oninput = inp.onchange = () => {
          const k = inp.dataset.k;
          const old = f.type;
          f[k] = inp.value;
          if (k === "type" && old !== f.type) {
            if (f.type === "BIT") { delete f.slot; f.word = dwords[dwords.length - 1]; f.bit = freeBits(f.word)[0] ?? 0; } else { delete f.word; delete f.bit; f.slot = f.slot ?? nextFreeEnd(); }
            if (f.type === "TEXT") { f.length = f.length || 8; f.strip = "both"; }
            f.group = groupOf(f.name, f.type);
            return rerender();
          }
          if (k === "word") return rerender();
          this.validate();
        };
      });
    });
    $$("[data-a]", b).forEach(x => x.onclick = () => { E.assign.has(x.dataset.a) ? E.assign.delete(x.dataset.a) : E.assign.add(x.dataset.a); x.classList.toggle("on"); });
    $("#veAllT").onclick = () => { termCr.forEach(c => E.assign.add(c)); rerender(); };
    $("#veNone").onclick = () => { E.assign.clear(); rerender(); };
    $("#veCrane").onchange = e => E.testCrane = e.target.value;
    $("#veTest").onclick = () => this.test();
    $("#veSave").onclick = () => this.save();
    this.validate();
  },
  payload() {
    const E = this.editor;
    const fields = E.base.fields.concat(E.newFields.map(f => {
      const o = {name: (f.name || "").trim(), type: f.type, group: f.group, unit: f.unit || "", description: f.description || ""};
      if (f.type === "BIT") { o.word = f.word === "" ? null : +f.word; o.bit = f.bit === "" ? null : +f.bit; } else o.slot = f.slot === "" ? null : +f.slot;
      if (f.type === "TEXT") { o.length = +f.length; o.strip = f.strip || "both"; }
      return o;
    }));
    return {program: E.program, name: E.name.trim(), notes: E.notes, base_id: E.base.id, packet_size: E.manualSize ? +E.manualSize : null, fields};
  },
  async validate() {
    clearTimeout(this._vt);
    this._vt = setTimeout(async () => {
      const p = this.payload();
      const r = await App.api("/api/versions/validate", {json: p});
      const E = this.editor;
      if (!E || !$("#veErr")) return;
      const errs = r.errors.slice();
      if (!E.newFields.length) errs.push("add at least one new field");
      $("#veErr").innerHTML = errs.map(e => `<li>${h(e)}</li>`).join("");
      $("#veAuto").textContent = r.packet_size ? `auto: ${r.packet_size} B (${r.packet_size / 4} slots)` : "";
      $("#veMap").innerHTML = this.pmap(p.fields.filter(f => f.type === "BIT" ? f.word != null : f.slot != null && !isNaN(f.slot)), Math.max(r.packet_size || 0, +E.manualSize || 0, E.base.packet_size), new Set(E.newFields.map(f => f.name.trim())));
      $("#veSave").disabled = errs.length > 0;
    }, 250);
  },
  async test() {
    const p = this.payload();
    const crane = $("#veCrane").value;
    try {
      const r = await App.api("/api/versions/test", {json: {crane, fields: p.fields, packet_size: p.packet_size}});
      const newNames = new Set(this.editor.newFields.map(f => f.name.trim()));
      const rows = r.decoded.filter(f => $("#veAllF").checked || newNames.has(f.name));
      const need = p.packet_size || 0;
      $("#veTestOut").innerHTML = `<div class="small ${r.size < need ? "warnlist" : "muted"}">${h(crane)}'s latest packet: ${r.size} bytes from ${h(r.ip)} (${App.ago(r.ts)})${r.size < need ? ` - shorter than this version needs (${need} B): has the PLC been updated yet?` : ""}</div>
        <div class="tbl-wrap" style="max-height:320px;margin-top:4px"><table class="t"><tr><th>Field</th><th>Type</th><th>Slot</th><th>Raw bytes</th><th>Decoded value</th><th></th></tr>${rows.map(f => `<tr class="${newNames.has(f.name) ? "newrow" : ""}"><td>${h(f.name)}</td><td>${f.type}</td><td>${f.type === "BIT" ? f.word + "." + f.bit : f.slot}</td><td class="mono">${h(f.raw)}</td><td class="mono"><b>${h(App.num(f.value, 4))}</b></td><td class="small" style="color:var(--danger)">${h(f.problem || "")}</td></tr>`).join("")}</table></div>`;
    } catch (e) { $("#veTestOut").innerHTML = `<div class="errlist">${h(e.message)}</div>`; }
  },
  async save() {
    const E = this.editor, p = this.payload();
    const v = await App.api("/api/versions/validate", {json: p});
    if (v.errors.length) return App.toast("Fix the problems first", "err");
    const assign = [...E.assign];
    const r = await App.confirm({title: `Save ${E.program} ${E.name}`, danger: assign.length > 0, okText: assign.length ? "Save & apply" : "Save",
      summary: `<b>${h(E.program)} ${h(E.name)}</b> = ${h(E.base.name)} + ${E.newFields.length} new field(s), packet size <b>${p.packet_size || v.packet_size} bytes</b>:
        <ul>${E.newFields.map(f => `<li class="mono">${h(f.name)} (${f.type}${f.type === "BIT" ? ` slot ${f.word} bit ${f.bit}` : ` slot ${f.slot}`})</li>`).join("")}</ul>
        ${assign.length ? `Cranes switched to it now: <b>${h(assign.join(", "))}</b> - only these reload in the collector.<br><b>Check their PLCs already send ${p.packet_size || v.packet_size}-byte packets</b> (Test on live data above).` : "No crane is switched yet - assign cranes later."}`});
    if (!r) return;
    try {
      const res = await App.api("/api/versions", {json: {...p, assign, ...r}});
      App.applied(res.assigned.length ? res : {applied: true, changes: []});
      this.editor = null; this.selected = res.id; this.render($("#cfgBody")); App.poll();
    } catch (e) { App.err(e); }
  },
};
