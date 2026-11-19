"""
app.py - Crane Data Manager platform (web page on http://127.0.0.1:5300).

Runs as the Windows service "CraneDataPlatform" (or by run.bat for testing).
The collector service does the collecting; this platform shows its state,
holds the configuration and sends it commands. If this page is closed or
crashes, collection is not affected.
"""
import io
import json
import logging
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from logging.handlers import RotatingFileHandler

from flask import Flask, jsonify, request, send_file, send_from_directory

from cdm import __version__
from cdm import config as C
from cdm import ctl, dashboard, db, exporter, influx, layouts, query, registry, smart
from cdm.collector import CraneConfig

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024
log = logging.getLogger("cdm.platform")
IS_WINDOWS = os.name == "nt"
STARTED = time.time()
_import_previews = {}
_status_cache = {"t": 0, "data": None, "error": None}
_status_lock = threading.Lock()


# ── helpers ──────────────────────────────────────────────────────────────────
class UserError(Exception):
    pass


@app.errorhandler(UserError)
def _user_error(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(ValueError)
def _value_error(e):
    return jsonify({"error": str(e)}), 400


@app.errorhandler(Exception)
def _any_error(e):
    from werkzeug.exceptions import HTTPException
    if isinstance(e, HTTPException):
        return e
    log.exception("request failed")
    return jsonify({"error": f"{type(e).__name__}: {e}"}), 500


@app.before_request
def _local_only():
    """Only this PC's own page may use the platform: reject other Host names
    (DNS rebinding) and changes sent from other web sites (CSRF)."""
    port = C.load_settings()["platform_port"]
    allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if request.host not in allowed:
        return jsonify({"error": "forbidden host"}), 403
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("Origin")
        if origin and origin.split("//", 1)[-1] not in allowed:
            return jsonify({"error": "forbidden origin"}), 403


def body():
    return request.get_json(silent=True) or {}


def need_reason(b):
    r = str(b.get("reason") or "").strip()
    if len(r) < 3:
        raise UserError("Please give a reason (it is saved in the change log).")
    return r


def collector_status(max_age=0.8):
    """Collector snapshot, cached briefly so many browser tabs cost nothing."""
    with _status_lock:
        if time.time() - _status_cache["t"] < max_age:
            return _status_cache["data"], _status_cache["error"]
        try:
            data, err = ctl.status(), None
        except ctl.CollectorDown as exc:
            data, err = None, str(exc)
        _status_cache.update(t=time.time(), data=data, error=err)
        return data, err


def apply_to_collector(reason):
    """Hot-reload the collector (only changed cranes restart)."""
    _status_cache["t"] = 0
    try:
        r = ctl.reload(reason)
        return {"applied": True, "changes": r.get("changes", [])}
    except ctl.CollectorDown:
        return {"applied": False, "changes": [],
                "note": "The collector service is not running: the change is saved and is "
                        "used as soon as the service starts."}


def desired_hashes():
    versions = {v["id"]: v for v in layouts.all_versions()}
    return {r["crane"]: CraneConfig(r, versions.get(r["version_id"])).hash
            for r in db.rows("SELECT * FROM cranes")}


def pending_changes(snap):
    if not snap:
        return []
    want = desired_hashes()
    have = {c: v["config_hash"] for c, v in snap["cranes"].items()}
    out = [c for c in want if have.get(c) != want[c]]
    out += [c for c in have if c not in want]
    return sorted(out)


# ── pages ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/meta")
def api_meta():
    s = C.load_settings()
    return jsonify({"version": __version__, "terminals": s["terminals"], "now": time.time(),
                    "programs": layouts.PROGRAMS, "program_rules": s.get("program_rules", {}),
                    "tz": "Dubai (GMT+4)", "sound": s["sound"], "yard": s["yard"],
                    "groups": layouts.GROUPS, "types": layouts.TYPES,
                    "influx_bucket": s["influx_bucket"], "influx_url": s["influx_url"],
                    "influx_org": s["influx_org"], "influx_measurement": s["influx_measurement"],
                    "westermo_ip": s.get("westermo_ip"), "collector_ip": s.get("collector_ip"),
                    "listen_address": s.get("listen_address")})


# ── live ─────────────────────────────────────────────────────────────────────
@app.route("/api/live")
def api_live():
    term = request.args.get("terminal") or None
    snap, err = collector_status()
    reg = registry.list_cranes()
    live = (snap or {}).get("cranes", {})
    cranes = []
    for c in reg:
        if term and c["terminal"] != term:
            continue
        v = live.get(c["crane"])
        if v is None:
            v = {"crane": c["crane"], "terminal": c["terminal"], "port": c["port"],
                 "ip": c["ip"], "enabled": bool(c["enabled"]), "version": c["version_name"],
                 "expected_size": c["packet_size"], "state": "DOWN" if err else "NOT_LOADED",
                 "flags": [], "pkt_min": 0, "received": 0, "written": 0, "dropped_ip": 0,
                 "values": {}, "intruders": {}, "recent_intruders": []}
        v["notes"] = c.get("notes", "")
        v.setdefault("program", c.get("program"))
        v["expected_program"] = registry.expected_program(c["crane"], c["terminal"])
        v["rule_warning"] = registry.rule_check(c["crane"], c["terminal"], c["port"])
        cranes.append(v)
    alarms = db.rows("SELECT id, ts, crane, terminal, type, message, acked FROM events "
                     "WHERE active=1 ORDER BY ts DESC")
    if term:
        alarms = [a for a in alarms if not a["terminal"] or a["terminal"] == term]
    counts = {}
    for c in cranes:
        counts[c["state"]] = counts.get(c["state"], 0) + 1
    all_counts = {}
    for t in C.load_settings()["terminals"]:
        tc = [c for c in reg if c["terminal"] == t]
        all_counts[t] = {
            "registered": len(tc),
            "ok": sum(1 for c in tc if live.get(c["crane"], {}).get("state") == "OK"),
            "alarm": sum(1 for c in tc if live.get(c["crane"], {}).get("state") in
                         ("IP_CONFLICT", "WRONG_SIZE", "PARSE_ERROR", "PORT_BUSY", "BUFFERING")),
        }
    return jsonify({
        "now": time.time(), "collector": {"up": snap is not None, "error": err,
                                          **((snap or {}).get("service") or {})},
        "writer": (snap or {}).get("writer"), "cranes": cranes, "counts": counts,
        "terminal_counts": all_counts, "alarms": alarms,
        "unacked": sum(1 for a in alarms if not a["acked"]),
        "pending": pending_changes(snap),
    })


@app.route("/api/crane/<crane>")
def api_crane(crane):
    crane = crane.upper()
    c = registry.get_crane(crane)
    if not c:
        raise UserError("unknown crane")
    snap, err = collector_status()
    live = (snap or {}).get("cranes", {}).get(crane)
    try:
        hist = ctl.history(crane)
    except ctl.CollectorDown:
        hist = {"fields": [], "points": []}
    today = C.local_now().strftime("%Y-%m-%d")
    v = layouts.get_version(c["version_id"]) if c["version_id"] else None
    return jsonify({
        "config": {**c, "version_name": v and v["name"], "packet_size": v and v["packet_size"],
                   "rule_port": registry.rule_port(crane, c["terminal"]),
                   "rule_warning": registry.rule_check(crane, c["terminal"], c["port"])},
        "live": live, "collector_error": err, "history": hist,
        "today": db.one("SELECT * FROM daily_stats WHERE date=? AND crane=?", (today, crane)),
        "insights": db.rows("SELECT * FROM insights WHERE crane=? ORDER BY ts DESC LIMIT 10",
                            (crane,)),
        "events": db.rows("SELECT * FROM events WHERE crane=? ORDER BY ts DESC LIMIT 25",
                          (crane,)),
    })


@app.route("/api/crane/<crane>/raw")
def api_crane_raw(crane):
    crane = crane.upper()
    which = request.args.get("which", "registered")
    try:
        r = ctl.raw(crane, which)
    except ctl.CollectorDown:
        raise UserError("the collector service is not running")
    if not r:
        return jsonify({"empty": True})
    data = bytes.fromhex(r["hex"])
    vid = request.args.get("version_id")
    c = registry.get_crane(crane)
    v = layouts.get_version(int(vid) if vid else c["version_id"])
    return jsonify({**r, "version": v and {"id": v["id"], "name": v["name"],
                                           "packet_size": v["packet_size"]},
                    "decoded": layouts.decode_preview(v, data) if v else [],
                    "words": [data[i:i + 4].hex() for i in range(0, len(data), 4)]})


# ── alarms / events ──────────────────────────────────────────────────────────
@app.route("/api/alarms/active")
def api_alarms_active():
    return jsonify(db.rows("SELECT id, ts, crane, terminal, type, severity, message, acked "
                           "FROM events WHERE active=1 ORDER BY ts DESC"))


@app.route("/api/events")
def api_events():
    a = request.args
    sql, args = "SELECT * FROM events WHERE ts>=?", [time.time() - float(a.get("days", 7)) * 86400]
    if a.get("active") == "1":
        sql += " AND active=1"
    if a.get("severity"):
        sql += " AND severity=?"
        args.append(a["severity"])
    if a.get("category"):
        sql += " AND category=?"
        args.append(a["category"])
    if a.get("terminal"):
        sql += " AND (terminal=? OR terminal IS NULL)"
        args.append(a["terminal"])
    if a.get("crane"):
        sql += " AND crane=?"
        args.append(a["crane"].upper())
    if a.get("q"):
        sql += " AND message LIKE ?"
        args.append(f"%{a['q']}%")
    sql += " ORDER BY ts DESC LIMIT ?"
    args.append(int(a.get("limit", 500)))
    rows = db.rows(sql, args)
    if a.get("format") == "csv":
        import csv
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["time (Dubai)", "terminal", "crane", "category", "type", "severity",
                    "message", "active", "acknowledged", "ack note", "cleared"])
        for r in rows:
            w.writerow([C.fmt_local(r["ts"]), r["terminal"], r["crane"], r["category"],
                        r["type"], r["severity"], r["message"], r["active"], r["acked"],
                        r["ack_note"], C.fmt_local(r["cleared_ts"])])
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8-sig")),
                         download_name="alarms_events.csv", as_attachment=True)
    return jsonify(rows)


@app.route("/api/alarms/<int:aid>/ack", methods=["POST"])
def api_ack(aid):
    note = str(body().get("note") or "")[:500]
    db.execute("UPDATE events SET acked=1, ack_note=?, ack_ts=? WHERE id=?",
               (note, time.time(), aid))
    return jsonify({"ok": True})


@app.route("/api/alarms/ack_all", methods=["POST"])
def api_ack_all():
    note = str(body().get("note") or "")[:500]
    db.execute("UPDATE events SET acked=1, ack_note=?, ack_ts=? WHERE active=1 AND acked=0",
               (note, time.time()))
    return jsonify({"ok": True})


# ── cranes ───────────────────────────────────────────────────────────────────
@app.route("/api/cranes")
def api_cranes():
    out = registry.list_cranes(request.args.get("terminal") or None)
    for c in out:
        c["rule_port"] = registry.rule_port(c["crane"], c["terminal"])
        c["rule_warning"] = registry.rule_check(c["crane"], c["terminal"], c["port"])
    return jsonify(out)


def _crane_from_body(b):
    try:
        ip = registry.norm_ip(b.get("ip"))
    except ValueError:
        raise UserError(f"'{b.get('ip')}' is not a valid IPv4 address")
    return {"crane": str(b.get("crane") or "").strip().upper(),
            "terminal": registry.norm_terminal(b.get("terminal")),
            "port": int(b["port"]) if str(b.get("port") or "").strip() else None,
            "ip": ip, "version_id": int(b["version_id"]) if b.get("version_id") else None,
            "enabled": bool(b.get("enabled", True)), "notes": str(b.get("notes") or "")}


@app.route("/api/cranes/validate", methods=["POST"])
def api_crane_validate():
    b = body()
    try:
        c = _crane_from_body(b)
    except UserError as e:
        return jsonify({"errors": [str(e)], "warnings": []})
    errs, warns = registry.validate_crane(c, registry.list_cranes(), C.load_settings())
    return jsonify({"errors": errs, "warnings": warns,
                    "rule_port": registry.rule_port(c["crane"], c["terminal"])})


@app.route("/api/cranes", methods=["POST"])
def api_crane_save():
    b = body()
    reason = need_reason(b)
    c = _crane_from_body(b)
    errs, warns = registry.validate_crane(c, registry.list_cranes(), C.load_settings())
    if errs:
        raise UserError("; ".join(errs))
    existing = registry.get_crane(c["crane"])
    if existing and b.get("original") and b["original"] != c["crane"]:
        raise UserError(f"{c['crane']} already exists")
    if b.get("original") and b["original"] != c["crane"]:
        registry.delete(b["original"], f"renamed to {c['crane']}: {reason}")
    registry.upsert(c, reason, "Edit crane" if existing else "Add crane")
    return jsonify({"ok": True, "warnings": warns, **apply_to_collector(reason)})


@app.route("/api/cranes/enable", methods=["POST"])
def api_crane_enable():
    b = body()
    reason = need_reason(b)
    cranes = [str(x).upper() for x in b.get("cranes") or []]
    enabled = bool(b.get("enabled"))
    if not cranes:
        raise UserError("no crane selected")
    if not enabled:
        expect = cranes[0] if len(cranes) == 1 else "STOP ALL" if b.get("all") else \
            f"STOP {len(cranes)}"
        if str(b.get("confirm_text") or "").strip().upper() != expect:
            raise UserError(f"Type {expect} to confirm.")
    registry.set_enabled(cranes, enabled, reason)
    return jsonify({"ok": True, **apply_to_collector(reason)})


@app.route("/api/cranes/version", methods=["POST"])
def api_crane_version():
    b = body()
    reason = need_reason(b)
    cranes = [str(x).upper() for x in b.get("cranes") or []]
    vid = int(b.get("version_id") or 0)
    if not cranes or not layouts.get_version(vid):
        raise UserError("choose cranes and a version")
    registry.set_version(cranes, vid, reason)
    return jsonify({"ok": True, **apply_to_collector(reason)})


@app.route("/api/cranes/<crane>", methods=["DELETE"])
def api_crane_delete(crane):
    b = body()
    reason = need_reason(b)
    crane = crane.upper()
    if str(b.get("confirm_text") or "").strip().upper() != crane:
        raise UserError(f"Type {crane} to confirm.")
    registry.delete(crane, reason)
    return jsonify({"ok": True, **apply_to_collector(reason)})


@app.route("/api/rule_port")
def api_rule_port():
    return jsonify({"port": registry.rule_port(request.args.get("crane", "").upper(),
                                               registry.norm_terminal(
                                                   request.args.get("terminal")))})


@app.route("/api/cranes/template")
def api_template():
    data = registry.build_template(prefill=request.args.get("prefill", "1") == "1")
    return send_file(io.BytesIO(data), download_name="crane_register_template.xlsx",
                     as_attachment=True,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/api/cranes/import/preview", methods=["POST"])
def api_import_preview():
    f = request.files.get("file")
    if not f:
        raise UserError("choose an Excel file")
    rows = registry.read_excel(f.read())
    if not rows:
        raise UserError("No crane rows found. The sheet needs at least the headers Crane and "
                        "Port (download the template).")
    pv = registry.import_preview(rows, request.form.get("remove_missing") == "1")
    token = secrets.token_hex(8)
    now = time.time()
    for k in [k for k, v in _import_previews.items() if now - v["t"] > 1800]:
        del _import_previews[k]
    _import_previews[token] = {"t": now, "preview": pv, "file": f.filename}
    return jsonify({"token": token, "file": f.filename, **pv})


@app.route("/api/cranes/import/apply", methods=["POST"])
def api_import_apply():
    b = body()
    reason = need_reason(b)
    item = _import_previews.pop(b.get("token"), None)
    if not item:
        raise UserError("The preview has expired - upload the file again.")
    pv = item["preview"]
    if pv["summary"]["problem"] and not b.get("skip_problems"):
        raise UserError("Some rows have problems. Fix the file, or tick 'apply the good rows "
                        "and skip the rows with problems'.")
    n = registry.import_apply(pv, f"{reason} (file {item['file']})")
    return jsonify({"ok": True, "applied": n, "removed": len(pv["removed"]),
                    **apply_to_collector(reason)})


# ── versions ─────────────────────────────────────────────────────────────────
@app.route("/api/versions")
def api_versions():
    use = {}
    for c in registry.list_cranes():
        use.setdefault(c["version_id"], []).append(c["crane"])
    out = []
    for v in layouts.all_versions():
        v["cranes"] = use.get(v["id"], [])
        v["field_count"] = len(v["fields"])
        if request.args.get("full") != "1":
            v.pop("fields")
        out.append(v)
    return jsonify(out)


@app.route("/api/versions/<int:vid>")
def api_version(vid):
    v = layouts.get_version(vid)
    if not v:
        raise UserError("version not found")
    v["cranes"] = [c["crane"] for c in registry.list_cranes() if c["version_id"] == vid]
    v["locked_names"] = [f["name"] for f in v["fields"]]
    return jsonify(v)


def _version_check(b):
    base = layouts.get_version(int(b["base_id"])) if b.get("base_id") else None
    fields = b.get("fields") or []
    for f in fields:
        f.setdefault("group", layouts.guess_group(f.get("name", ""), f.get("type", "")))
        for k in ("slot", "word", "bit", "length"):
            if k in f and f[k] not in (None, ""):
                try:
                    f[k] = int(f[k])
                except (TypeError, ValueError):
                    pass
    size = int(b.get("packet_size") or layouts.min_size(
        [f for f in fields if f.get("type") in layouts.TYPES and
         (f.get("type") == "BIT" or str(f.get("slot", "")).isdigit())]) or 0)
    others = [v for v in layouts.all_versions() if not base or v["id"] != base["id"]]
    errs = layouts.validate(fields, size, base=base, others=others)
    name = str(b.get("name") or "").strip()
    term = b.get("program")
    if term not in layouts.PROGRAMS and not db.one("SELECT id FROM versions WHERE program=?",
                                                   (term,)):
        errs.append(f"unknown program '{term}'")
    if not name:
        errs.append("give the version a name, e.g. v2.2")
    elif db.one("SELECT id FROM versions WHERE program=? AND lower(name)=lower(?)",
                (term, name)):
        errs.append(f"{term} already has a version named {name}")
    return base, fields, size, errs


@app.route("/api/versions/validate", methods=["POST"])
def api_version_validate():
    b = body()
    _, fields, size, errs = _version_check(b)
    return jsonify({"errors": errs, "packet_size": size,
                    "min_size": layouts.min_size([f for f in fields if "slot" in f or
                                                  f.get("type") == "BIT"]) if not errs else None})


@app.route("/api/versions/test", methods=["POST"])
def api_version_test():
    """Decode the crane's latest real packet with an unsaved version."""
    b = body()
    crane = str(b.get("crane") or "").upper()
    try:
        r = ctl.raw(crane, b.get("which", "registered"))
    except ctl.CollectorDown:
        raise UserError("the collector service is not running")
    if not r:
        raise UserError(f"no packet received from {crane} yet")
    data = bytes.fromhex(r["hex"])
    fields = b.get("fields") or []
    for f in fields:
        for k in ("slot", "word", "bit", "length"):
            if f.get(k) not in (None, ""):
                f[k] = int(f[k])
    v = {"id": 0, "name": "test", "packet_size": int(b.get("packet_size") or len(data)),
         "fields": fields}
    return jsonify({"size": len(data), "ip": r["ip"], "ts": r["ts"],
                    "decoded": layouts.decode_preview(v, data)})


@app.route("/api/versions", methods=["POST"])
def api_version_create():
    b = body()
    reason = need_reason(b)
    base, fields, size, errs = _version_check(b)
    if errs:
        raise UserError("; ".join(errs))
    term = b["program"]
    registry.backup(f"New version {term} {b['name']}")
    vid = db.execute("INSERT INTO versions(program,name,base_id,packet_size,fields_json,notes,"
                     "created) VALUES(?,?,?,?,?,?,?)",
                     (term, b["name"].strip(), base and base["id"], size, json.dumps(fields),
                      str(b.get("notes") or ""), time.time()))
    new_names = [f["name"] for f in fields if not base or f["name"] not in
                 {x["name"] for x in base["fields"]}]
    db.audit("New version", f"{term} {b['name']}", reason, None,
             {"packet_size": size, "added_fields": new_names})
    assign = [str(x).upper() for x in b.get("assign") or []]
    res = {}
    if assign:
        registry.set_version(assign, vid, reason)
        res = apply_to_collector(reason)
    return jsonify({"ok": True, "id": vid, "assigned": assign, **res})


@app.route("/api/versions/<int:vid>", methods=["DELETE"])
def api_version_delete(vid):
    b = body()
    reason = need_reason(b)
    v = layouts.get_version(vid)
    if not v:
        raise UserError("version not found")
    if any(c["version_id"] == vid for c in registry.list_cranes()):
        raise UserError("cranes still run this version - assign them another version first")
    if db.one("SELECT id FROM versions WHERE base_id=?", (vid,)):
        raise UserError("another version was built from this one - it cannot be deleted")
    if vid in (db.meta_get("baseline_ids") or [1, 2, 3, 4]):
        raise UserError("baseline versions cannot be deleted")
    registry.backup(f"Delete version {v['name']}")
    db.execute("DELETE FROM versions WHERE id=?", (vid,))
    db.audit("Delete version", f"{v['program']} {v['name']}", reason)
    return jsonify({"ok": True})


@app.route("/api/fields")
def api_fields():
    cranes = [c for c in (request.args.get("cranes") or "").upper().split(",") if c]
    return jsonify(query.field_catalog(cranes or None))


# ── collector / system ───────────────────────────────────────────────────────
@app.route("/api/collector/refresh", methods=["POST"])
def api_refresh():
    b = body()
    reason = need_reason(b)
    db.audit("Refresh collector", "collector", reason)
    r = apply_to_collector(reason)
    if not r["applied"]:
        raise UserError(r["note"])
    return jsonify(r)


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    s = C.load_settings()
    if request.method == "GET":
        return jsonify({**s, "token_present": bool(C.read_token())})
    b = body()
    reason = need_reason(b)
    allowed = {"influx_url", "influx_org", "influx_bucket", "sound", "desktop_popups",
               "popup_types", "no_data_after_sec", "yard", "terminals", "westermo_ip",
               "collector_ip"}
    before = {k: s.get(k) for k in allowed}
    for k in allowed:
        if k in b:
            s[k] = b[k]
    C.save_settings(s)
    db.audit("Change settings", "settings", reason, before, {k: s.get(k) for k in allowed})
    needs_restart = any(before[k] != s[k] for k in ("influx_url", "influx_org", "influx_bucket",
                                                    "no_data_after_sec"))
    return jsonify({"ok": True, "restart_collector": needs_restart})


@app.route("/api/influx/test", methods=["POST"])
def api_influx_test():
    s = C.load_settings()
    b = body()
    for k in ("influx_url", "influx_org", "influx_bucket"):
        if b.get(k):
            s[k] = b[k]
    h = influx.health(s)
    if h["ok"]:
        try:
            list(query.iter_rows(f'from(bucket: "{s["influx_bucket"]}") |> range(start: -1m) '
                                 f'|> limit(n: 1)', s, 8000))
            h["bucket"] = "readable"
        except Exception as exc:                          # noqa: BLE001
            h["bucket"] = f"cannot read bucket: {str(exc)[:200]}"
    return jsonify(h)


@app.route("/api/service/restart_collector", methods=["POST"])
def api_restart_collector():
    b = body()
    reason = need_reason(b)
    if str(b.get("confirm_text") or "").strip().upper() != "RESTART":
        raise UserError("Type RESTART to confirm.")
    ok, msg = restart_service(C.load_settings()["service_name_collector"])
    db.audit("Restart collector service", "collector", reason, None, {"result": msg})
    if not ok:
        raise UserError(msg)
    return jsonify({"ok": True, "message": msg})


@app.route("/api/backups")
def api_backups():
    return jsonify(registry.list_backups())


@app.route("/api/backups/restore", methods=["POST"])
def api_backup_restore():
    b = body()
    reason = need_reason(b)
    if str(b.get("confirm_text") or "").strip().upper() != "RESTORE":
        raise UserError("Type RESTORE to confirm.")
    registry.restore_backup(b.get("file", ""), reason)
    return jsonify({"ok": True, **apply_to_collector(reason)})


@app.route("/api/audit")
def api_audit():
    return jsonify(db.rows("SELECT * FROM audit ORDER BY ts DESC LIMIT ?",
                           (int(request.args.get("limit", 300)),)))


@app.route("/api/selftest")
def api_selftest():
    s = C.load_settings()
    checks = []

    def add(name, ok, detail, level=None):
        checks.append({"name": name, "ok": ok, "level": level or ("ok" if ok else "error"),
                       "detail": detail})
    snap, err = collector_status(0)
    add("Collector service", snap is not None,
        f"running, pid {snap['service']['pid']}, since {C.fmt_local(snap['service']['started'])}"
        if snap else f"not reachable: {err}")
    if snap:
        w = snap["writer"]
        add("InfluxDB writes", w["healthy"] is not False,
            "OK" if w["healthy"] else ("no data written yet" if w["healthy"] is None
                                       else f"failing: {w['last_error']}"),
            "ok" if w["healthy"] else ("warning" if w["healthy"] is None else "error"))
        add("Outage buffer", w["buffered"] == 0,
            "empty" if not w["buffered"] else f"{w['buffered']} points waiting "
                                              f"({w['buffer_bytes'] / 1e6:.1f} MB)", None
            if not w["buffered"] else "warning")
        busy = [c for c, v in snap["cranes"].items() if v.get("bind_error")]
        add("UDP ports", not busy, "all crane ports open" if not busy else
            "cannot open: " + ", ".join(f"{c} ({snap['cranes'][c]['port']})" for c in busy))
        add("Listener threads", snap["service"]["threads_ok"],
            f"{snap['service']['listeners']} listeners alive"
            if snap["service"]["threads_ok"] else "a listener thread is not alive")
        pend = pending_changes(snap)
        add("Configuration loaded", not pend, "collector runs the saved configuration" if not
            pend else "waiting for refresh: " + ", ".join(pend), None if not pend else "warning")
    h = influx.health(s)
    add("InfluxDB reachable", h["ok"], f"{s['influx_url']} - {h.get('message')}")
    add("InfluxDB token", bool(C.read_token()),
        "influx_token.txt found" if C.read_token() else "create influx_token.txt next to app.py")
    free = shutil.disk_usage(C.DATA_DIR).free
    add("Disk space", free > 5e9, f"{free / 1e9:.1f} GB free", None if free > 5e9 else
        ("warning" if free > 2e9 else "error"))
    reg = registry.list_cranes()
    noip = [c["crane"] for c in reg if not c["ip"]]
    add("Crane register", not noip, f"{len(reg)} cranes" + (f"; missing IP: {', '.join(noip)}"
                                                            if noip else ""))
    if IS_WINDOWS:
        for svc in (s["service_name_collector"], s["service_name_platform"]):
            st = service_state(svc)
            add(f"Windows service {svc}", st == "RUNNING", st or "not installed",
                None if st == "RUNNING" else "warning")
    return jsonify(checks)


# ── dashboard ────────────────────────────────────────────────────────────────
@app.route("/api/dashboard")
def api_dashboard():
    return jsonify(dashboard.build(request.args.get("terminal") or None,
                                   request.args.get("date") or None))


@app.route("/api/insights")
def api_insights():
    return jsonify(db.rows("SELECT * FROM insights WHERE ts>=? ORDER BY ts DESC LIMIT 300",
                           (time.time() - float(request.args.get("days", 7)) * 86400,)))


# ── data / query / export ────────────────────────────────────────────────────
@app.route("/api/query", methods=["POST"])
def api_query():
    b = body()
    try:
        return jsonify(query.run(b, max_rows=int(b.get("max_rows") or 5000)))
    except ValueError:
        raise
    except Exception as exc:                              # noqa: BLE001
        raise UserError("InfluxDB query failed: " + influx._err_text(exc))


@app.route("/api/query/flux", methods=["POST"])
def api_query_flux_text():
    b = body()
    if b.get("build"):
        return jsonify({"flux": query.build_flux(b["build"])})
    try:
        return jsonify(query.run_flux(b.get("flux") or ""))
    except ValueError:
        raise
    except Exception as exc:                              # noqa: BLE001
        raise UserError("InfluxDB query failed: " + influx._err_text(exc))


@app.route("/api/smart", methods=["POST"])
def api_smart():
    return jsonify(smart.parse(body().get("text", "")))


@app.route("/api/saved_queries", methods=["GET", "POST"])
def api_saved():
    if request.method == "GET":
        out = db.rows("SELECT * FROM saved_queries ORDER BY name")
        for r in out:
            r["spec"] = json.loads(r["spec"])
        return jsonify(out)
    b = body()
    name = str(b.get("name") or "").strip()
    if not name:
        raise UserError("give the query a name")
    db.execute("INSERT INTO saved_queries(name,spec,created) VALUES(?,?,?) ON CONFLICT(name) DO "
               "UPDATE SET spec=excluded.spec", (name, json.dumps(b.get("spec") or {}),
                                                 time.time()))
    return jsonify({"ok": True})


@app.route("/api/saved_queries/<int:qid>", methods=["DELETE"])
def api_saved_delete(qid):
    db.execute("DELETE FROM saved_queries WHERE id=?", (qid,))
    return jsonify({"ok": True})


@app.route("/api/replay", methods=["POST"])
def api_replay():
    b = body()
    try:
        return jsonify(query.positions([c.upper() for c in b["cranes"]], b["start"], b["stop"],
                                       b.get("every", "5s")))
    except ValueError:
        raise
    except Exception as exc:                              # noqa: BLE001
        raise UserError("InfluxDB query failed: " + influx._err_text(exc))


@app.route("/api/export", methods=["POST"])
def api_export():
    b = body()
    if not b.get("cranes"):
        raise UserError("choose at least one crane")
    query.parse_local(b["start"])
    query.parse_local(b["stop"])
    return jsonify({"id": exporter.start(b)})


@app.route("/api/exports")
def api_exports():
    return jsonify(exporter.list_jobs())


@app.route("/api/exports/<int:jid>/download")
def api_export_download(jid):
    j = db.one("SELECT * FROM exports WHERE id=?", (jid,))
    if not j or not j["file"]:
        raise UserError("file not ready")
    p = C.EXPORT_DIR / j["file"]
    if not p.exists():
        raise UserError("the file was removed")
    return send_file(p, download_name=exporter.download_name(j["file"]), as_attachment=True)


# ── Engineering Building ─────────────────────────────────────────────────────
_bs_cache = {"t": 0, "v": None}


@app.route("/building/status")
def building_status():
    try:
        if time.time() - _bs_cache["t"] < 5 and _bs_cache["v"]:
            return jsonify(_bs_cache["v"])
        snap, err = collector_status(5)
        cranes = (snap or {}).get("cranes", {})
        today = C.local_now().strftime("%Y-%m-%d")
        st = db.one("SELECT SUM(received) r FROM daily_stats WHERE date=?", (today,)) or {}
        alarms_today = db.one("SELECT COUNT(*) n FROM events WHERE severity='alarm' AND ts>=?",
                              (time.time() - 86400,)) or {}
        live = sum(1 for v in cranes.values() if v.get("live"))
        bad = [v for v in cranes.values() if v.get("state") in
               ("IP_CONFLICT", "WRONG_SIZE", "PARSE_ERROR", "PORT_BUSY")]
        v = {
            "platform": "Crane Data Manager",
            "status": "error" if (snap is None or bad) else ("working" if live else "idle"),
            "current_job": {"step": f"collecting {live} crane(s)", "items_done": live,
                            "items_total": len(cranes)} if live else None,
            "counters": {"items_today": st.get("r") or 0,
                         "items_last_hour": sum(v.get("pkt_min", 0) for v in cranes.values()) * 60,
                         "issues_today": alarms_today.get("n") or 0},
            "last_error": err or (bad[0]["state"] + " on " + bad[0]["crane"] if bad else None),
            "team": [
                {"role": "Collector operator", "description": "Starts one collector per crane "
                 "and restarts them after a PC restart", "automated": True,
                 "manual_minutes_per_item": 2},
                {"role": "Communication watcher", "description": "Checks every crane is "
                 "sending, from the right IP and with the right packet size", "automated": True,
                 "manual_minutes_per_item": 1},
                {"role": "Data exporter", "description": "Queries InfluxDB and prepares Excel "
                 "files per crane and day", "automated": True, "manual_minutes_per_item": 10},
                {"role": "PLC / network engineer", "description": "Fixes PLC ports, IPs and "
                 "packet layouts when the platform flags them", "automated": False,
                 "manual_minutes_per_item": 30},
            ],
        }
        _bs_cache.update(t=time.time(), v=v)
        return jsonify(v)
    except Exception as exc:                              # noqa: BLE001
        return jsonify({"platform": "Crane Data Manager", "status": "error", "current_job": None,
                        "counters": {"items_today": 0, "items_last_hour": 0, "issues_today": 0},
                        "last_error": str(exc), "team": []})


# ── Windows services / watchdog ──────────────────────────────────────────────
def service_state(name):
    if not IS_WINDOWS:
        return None
    try:
        out = subprocess.run(["sc", "query", name], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    for line in out.stdout.splitlines():
        if "STATE" in line:
            return line.split()[-1]
    return "UNKNOWN"


def restart_service(name):
    if not IS_WINDOWS:
        return False, "only available on Windows"
    st = service_state(name)
    if st is None:
        return False, f"Windows service {name} is not installed (run install_service.bat)"
    try:
        if st == "RUNNING":
            subprocess.run(["sc", "stop", name], capture_output=True, timeout=30)
            for _ in range(30):
                if service_state(name) == "STOPPED":
                    break
                time.sleep(1)
        r = subprocess.run(["sc", "start", name], capture_output=True, text=True, timeout=30)
        return r.returncode == 0, (r.stdout or r.stderr).strip()[-300:] or "started"
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)


def watchdog():
    """Keeps the collector service alive and raises SERVICE_DOWN if it is not."""
    down_since, last_try, was_down = None, 0, False
    name = C.load_settings()["service_name_collector"]
    time.sleep(10)
    while True:
        try:
            ctl.ping()
            if was_down:
                db.clear_alarm("PLATFORM:SERVICE_DOWN")
                db.add_event("SERVICE", "Collector service is responding again", "info")
            down_since, was_down = None, False
        except ctl.CollectorDown as exc:
            now = time.time()
            down_since = down_since or now
            if now - down_since > 20:
                was_down = True
                db.raise_alarm("PLATFORM:SERVICE_DOWN", "SERVICE_DOWN",
                               f"Collector service is not responding ({exc}). No data is being "
                               f"collected. The platform tries to restart it.")
                if now - last_try > 120:
                    last_try = now
                    st = service_state(name)
                    if st is not None:
                        ok, msg = restart_service(name)
                        db.add_event("SERVICE", f"Watchdog restarted {name}: {msg}",
                                     "warning")
        except Exception:                                 # noqa: BLE001
            log.exception("watchdog")
        time.sleep(5)


def housekeeping():
    while True:
        try:
            exporter.cleanup()
        except Exception:                                 # noqa: BLE001
            log.exception("housekeeping")
        time.sleep(3600)


def setup_logging():
    C.ensure_dirs()
    fh = RotatingFileHandler(C.LOG_DIR / "platform.log", maxBytes=5 * 1024 * 1024,
                             backupCount=3, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s  %(levelname)s  %(name)s  %(message)s"))
    logging.getLogger().addHandler(fh)
    logging.getLogger().setLevel(logging.INFO)


def main():
    setup_logging()
    db.init()
    s = C.load_settings()
    db.add_event("PLATFORM", "Platform started", "info")
    threading.Thread(target=watchdog, daemon=True, name="watchdog").start()
    threading.Thread(target=housekeeping, daemon=True, name="housekeeping").start()
    host, port = s["platform_host"], int(s["platform_port"])
    url = f"http://127.0.0.1:{port}/"
    if "--open" in sys.argv:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    print(f"Crane Data Manager on {url}")
    from waitress import serve
    serve(app, host=host, port=port, threads=12, channel_timeout=300)


if __name__ == "__main__":
    main()
