"""
registry.py
===========
The crane register: terminal, crane, port, registered IP, version, enabled.
Validation, the port rule check, the Excel template and the Excel import
(with a preview before anything is applied), plus config backups.
"""
import io
import ipaddress
import json
import re
import time
from datetime import datetime

from . import config as C
from . import db, layouts

CRANE_RE = re.compile(r"^([A-Z])(\d)(\d{2})$")
TEMPLATE_COLUMNS = ["Terminal", "Crane", "Port", "IP", "Version", "Enabled", "Notes"]

# Cranes known from the current collectors (ports only - you fill in the IPs).
KNOWN_CRANES = [
    ("T2", "A201", 12201, "v2.1"), ("T2", "A203", 12213, "v2.1"), ("T2", "A204", 12219, "v2.1"),
    ("T2", "A205", 12225, "v2.1"), ("T2", "A206", 12231, "v2.1"), ("T2", "A208", 12243, "v2.1"),
    ("T2", "A209", 12249, "v2.1"), ("T2", "A210", 12255, "v2.1"), ("T2", "A212", 12267, "v2.1"),
    ("T2", "B203", 12214, "v2.1"), ("T2", "B204", 12220, "v2.1"), ("T2", "C201", 12203, "v2"),
    ("T2", "C203", 12215, "v2"), ("T2", "C207", 12239, "v2"), ("T2", "C210", 12257, "v2"),
    ("T2", "D207", 12240, "v2.1"), ("T2", "E202", 12211, "v2.1"), ("T2", "E208", 12247, "v2"),
    ("T3", "B308", 12337, "v3"), ("T3", "B309", 12342, "v3"), ("T3", "A301", 12301, "v3"),
    ("T3", "C308", 12338, "v3"),
    ("T4", "B404", 12417, "v4"), ("T4", "F209", 12254, "v4"), ("T4", "F202", 12212, "v4"),
]


# ── Port rule ────────────────────────────────────────────────────────────────
def parse_crane_id(crane):
    m = CRANE_RE.match(crane or "")
    if not m:
        return None
    return {"lane": m.group(1), "terminal_digit": int(m.group(2)), "number": int(m.group(3))}


def rule_port(crane, terminal, settings=None):
    """Expected port from the crane ID:
       base + (crane number - 1) x number of lanes + lane position (A=1, B=2 ...)
       T2: 12200 + (n-1) x 6 + lane      T3 / T4: 12300 / 12400 + (n-1) x 5 + lane"""
    s = settings or C.load_settings()
    t = s["terminals"].get(terminal)
    p = parse_crane_id(crane)
    if not t or not p or p["lane"] not in t["lanes"]:
        return None
    return t["port_base"] + (p["number"] - 1) * len(t["lanes"]) + t["lanes"].index(p["lane"]) + 1


def rule_check(crane, terminal, port, settings=None):
    """Advisory only: your list is the master. Returns a warning text or ''."""
    exp = rule_port(crane, terminal, settings)
    p = parse_crane_id(crane)
    notes = []
    if p and terminal and terminal[-1].isdigit() and p["terminal_digit"] != int(terminal[-1]):
        notes.append(f"crane ID {crane} looks like Terminal {p['terminal_digit']}, "
                     f"registered under {terminal}")
    if exp and port and int(port) != exp:
        notes.append(f"port {port} does not follow the {terminal} port rule (expected {exp})")
    return "; ".join(notes)


# ── Read / validate ──────────────────────────────────────────────────────────
def list_cranes(terminal=None):
    sql = ("SELECT c.*, v.name AS version_name, v.packet_size AS packet_size, "
           "v.terminal AS version_terminal FROM cranes c LEFT JOIN versions v ON v.id=c.version_id")
    if terminal:
        return db.rows(sql + " WHERE c.terminal=? ORDER BY c.crane", (terminal,))
    return db.rows(sql + " ORDER BY c.terminal, c.crane")


def get_crane(crane):
    return db.one("SELECT * FROM cranes WHERE crane=?", (crane,))


def norm_ip(ip):
    ip = (ip or "").strip()
    if not ip:
        return ""
    return str(ipaddress.IPv4Address(ip))


def norm_terminal(t):
    t = str(t or "").strip().upper()
    if t.isdigit():
        t = "T" + t
    if t.startswith("TERMINAL"):
        t = "T" + t.replace("TERMINAL", "").strip()
    return t


def find_version(terminal, name):
    name = str(name or "").strip()
    if not name:
        return None
    if isinstance(name, str) and re.match(r"^\d+(\.\d+)?$", name):
        name = "v" + name                                   # 2.1 -> v2.1
    if not name.lower().startswith("v"):
        name = "v" + name
    vs = db.rows("SELECT id, terminal, name FROM versions WHERE lower(name)=lower(?)", (name,))
    for v in vs:
        if v["terminal"] == terminal:
            return v
    return vs[0] if len(vs) == 1 else None


def validate_crane(c, others, settings):
    """c = {terminal, crane, port, ip, version_id, enabled}. Returns (errors, warnings)."""
    errs, warns = [], []
    if not CRANE_RE.match(c.get("crane") or ""):
        errs.append("crane ID must look like A201 (lane letter + 3 digits)")
    if c.get("terminal") not in settings["terminals"]:
        errs.append(f"unknown terminal '{c.get('terminal')}'")
    port = c.get("port")
    if not port:
        errs.append("port is required")
    elif not 1024 <= int(port) <= 65535:
        errs.append("port must be 1024..65535")
    if not c.get("ip"):
        errs.append("IP is required (the collector only accepts the registered IP)")
    if not c.get("version_id"):
        errs.append("version is required")
    for o in others:
        if o["crane"] == c.get("crane"):
            continue
        if port and o.get("port") and int(o["port"]) == int(port):
            errs.append(f"port {port} is already used by {o['crane']}")
        if c.get("ip") and o.get("ip") == c.get("ip"):
            errs.append(f"IP {c['ip']} is already registered for {o['crane']}")
    if c.get("version_id"):
        v = db.one("SELECT terminal, name FROM versions WHERE id=?", (c["version_id"],))
        if not v:
            errs.append("version not found")
        elif v["terminal"] != c.get("terminal"):
            warns.append(f"runs the {v['terminal']} layout {v['name']}")
    w = rule_check(c.get("crane"), c.get("terminal"), port, settings) if port else ""
    if w:
        warns.append(w)
    return errs, warns


# ── Write (with backup + audit) ──────────────────────────────────────────────
def snapshot():
    return {"cranes": db.rows("SELECT * FROM cranes ORDER BY crane"),
            "versions": db.rows("SELECT * FROM versions ORDER BY id")}


def backup(reason):
    C.ensure_dirs()
    name = datetime.now(C.LOCAL_TZ).strftime("config_%Y%m%d_%H%M%S_%f.json")
    (C.BACKUP_DIR / name).write_text(json.dumps({"reason": reason, "ts": time.time(),
                                                 **snapshot()}, indent=1), encoding="utf-8")
    files = sorted(C.BACKUP_DIR.glob("config_*.json"))
    for old in files[:-50]:
        old.unlink(missing_ok=True)
    return name


def list_backups():
    out = []
    for p in sorted(C.BACKUP_DIR.glob("config_*.json"), reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append({"file": p.name, "ts": d.get("ts"), "reason": d.get("reason"),
                        "cranes": len(d.get("cranes", [])), "versions": len(d.get("versions", []))})
        except (OSError, ValueError):
            pass
    return out


def restore_backup(name, reason):
    p = C.BACKUP_DIR / name
    if not p.exists() or p.parent != C.BACKUP_DIR:
        raise ValueError("backup not found")
    d = json.loads(p.read_text(encoding="utf-8"))
    backup(f"before restoring {name}")
    with db.tx() as con:
        con.execute("DELETE FROM cranes")
        for c in d["cranes"]:
            con.execute("INSERT INTO cranes(crane,terminal,port,ip,version_id,enabled,notes,"
                        "created,updated) VALUES(?,?,?,?,?,?,?,?,?)",
                        (c["crane"], c["terminal"], c["port"], c["ip"], c["version_id"],
                         c["enabled"], c.get("notes", ""), c.get("created"), time.time()))
        con.execute("DELETE FROM versions")
        for v in d["versions"]:
            con.execute("INSERT INTO versions(id,terminal,name,base_id,packet_size,fields_json,"
                        "notes,created) VALUES(?,?,?,?,?,?,?,?)",
                        (v["id"], v["terminal"], v["name"], v["base_id"], v["packet_size"],
                         v["fields_json"], v.get("notes", ""), v.get("created")))
    db.audit("Restore configuration", name, reason)


def upsert(c, reason, action="Save crane", make_backup=True):
    before = get_crane(c["crane"])
    if make_backup:
        backup(f"{action} {c['crane']}")
    now = time.time()
    db.execute("INSERT INTO cranes(crane,terminal,port,ip,version_id,enabled,notes,created,updated)"
               " VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(crane) DO UPDATE SET terminal=excluded.terminal,"
               " port=excluded.port, ip=excluded.ip, version_id=excluded.version_id,"
               " enabled=excluded.enabled, notes=excluded.notes, updated=excluded.updated",
               (c["crane"], c["terminal"], int(c["port"]), c["ip"], int(c["version_id"]),
                1 if c.get("enabled", True) else 0, c.get("notes", ""), now, now))
    db.audit(action, c["crane"], reason, before, get_crane(c["crane"]))


def set_enabled(cranes, enabled, reason):
    backup(("Start " if enabled else "Stop ") + ",".join(cranes))
    for cr in cranes:
        before = get_crane(cr)
        if not before:
            continue
        db.execute("UPDATE cranes SET enabled=?, updated=? WHERE crane=?",
                   (1 if enabled else 0, time.time(), cr))
        db.audit("Start writing" if enabled else "Stop writing", cr, reason,
                 {"enabled": before["enabled"]}, {"enabled": 1 if enabled else 0})


def set_version(cranes, version_id, reason):
    v = db.one("SELECT name FROM versions WHERE id=?", (version_id,))
    backup(f"Assign {v['name'] if v else version_id}")
    for cr in cranes:
        before = get_crane(cr)
        if before:
            db.execute("UPDATE cranes SET version_id=?, updated=? WHERE crane=?",
                       (version_id, time.time(), cr))
            db.audit("Change version", cr, reason, {"version_id": before["version_id"]},
                     {"version_id": version_id})


def delete(crane, reason, make_backup=True):
    before = get_crane(crane)
    if make_backup:
        backup(f"Remove {crane}")
    db.execute("DELETE FROM cranes WHERE crane=?", (crane,))
    db.audit("Remove crane", crane, reason, before, None)


# ── Excel template / import ──────────────────────────────────────────────────
def build_template(prefill=True) -> bytes:
    import openpyxl
    from openpyxl.styles import Font, PatternFill
    from openpyxl.worksheet.datavalidation import DataValidation
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Cranes"
    ws.append(TEMPLATE_COLUMNS)
    for c in ws[1]:
        c.font = Font(bold=True, color="FFFFFF")
        c.fill = PatternFill("solid", fgColor="185FA5")
    existing = {c["crane"]: c for c in list_cranes()}
    if prefill:
        seen = set()
        for c in existing.values():
            ws.append([c["terminal"], c["crane"], c["port"], c["ip"], c["version_name"],
                       "Yes" if c["enabled"] else "No", c.get("notes", "")])
            seen.add(c["crane"])
        for term, crane, port, ver in KNOWN_CRANES:
            if crane not in seen:
                ws.append([term, crane, port, "", ver, "Yes", "fill in the PLC IP"])
    for col, w in zip("ABCDEFG", (10, 10, 10, 16, 10, 9, 36)):
        ws.column_dimensions[col].width = w
    dv = DataValidation(type="list", formula1='"Yes,No"', allow_blank=True)
    ws.add_data_validation(dv)
    dv.add("F2:F2000")
    vs = wb.create_sheet("Versions")
    vs.append(["Terminal", "Version", "Packet size (bytes)", "Fields"])
    for v in layouts.all_versions():
        vs.append([v["terminal"], v["name"], v["packet_size"], len(v["fields"])])
    hs = wb.create_sheet("Help")
    for line in [
        "One row per crane. Every sheet named 'Cranes' (or any sheet with these headers) is read.",
        "Terminal: T2, T3 or T4.   Crane: e.g. E208.   Port: the crane's UDP port, e.g. 12247.",
        "IP: the crane PLC's IP address. Required: the collector only accepts this IP on this port.",
        "Version: a packet version name from the 'Versions' sheet, e.g. v2.1 (2.1 also works).",
        "Enabled: Yes = collect and write to InfluxDB.  No = keep listening but do not write.",
        "Nothing is changed until you check the preview in the platform and confirm.",
        "Cranes that are in the platform but not in the file are only removed if you tick",
        "'Remove cranes not in the file' in the preview.",
    ]:
        hs.append([line])
    hs.column_dimensions["A"].width = 110
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def read_excel(data: bytes):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    out = []
    for ws in wb.worksheets:
        it = ws.iter_rows(values_only=True)
        header = next(it, None)
        if not header:
            continue
        cols = {str(h).strip().lower(): i for i, h in enumerate(header) if h is not None}
        if "crane" not in cols or "port" not in cols:
            continue
        get = lambda r, k: r[cols[k]] if k in cols and cols[k] < len(r) else None  # noqa
        vkey = "version" if "version" in cols else ("collector version"
                                                    if "collector version" in cols else None)
        for i, r in enumerate(it, start=2):
            crane = get(r, "crane")
            if crane is None or str(crane).strip() == "":
                continue
            ver = get(r, vkey) if vkey else None
            if isinstance(ver, float):
                ver = f"{ver:g}"
            en = get(r, "enabled")
            out.append({
                "sheet": ws.title, "row": i,
                "crane": str(crane).strip().upper(),
                "terminal": norm_terminal(get(r, "terminal") or ""),
                "port": get(r, "port"),
                "ip": get(r, "ip"),
                "version": None if ver is None else str(ver).strip(),
                "enabled": None if en is None else str(en).strip().lower() in
                ("yes", "y", "1", "true", "on", "enabled"),
                "notes": str(get(r, "notes") or ""),
            })
    return out


def import_preview(rows_in, remove_missing=False):
    """Compare the Excel rows with the register. Nothing is written."""
    s = C.load_settings()
    current = {c["crane"]: c for c in list_cranes()}
    result, final = [], {k: dict(v) for k, v in current.items()}
    for r in rows_in:
        item = {"crane": r["crane"], "sheet": r["sheet"], "row": r["row"], "errors": [],
                "warnings": [], "changes": []}
        term = r["terminal"]
        if not term:
            p = parse_crane_id(r["crane"])
            term = f"T{p['terminal_digit']}" if p else ""
            if term:
                item["warnings"].append(f"no terminal given, using {term} from the crane ID")
        try:
            port = int(float(r["port"])) if r["port"] not in (None, "", "NA", "na") else None
        except (TypeError, ValueError):
            port = None
            item["errors"].append(f"port '{r['port']}' is not a number")
        try:
            ip = norm_ip(str(r["ip"]) if r["ip"] is not None else "")
        except ValueError:
            ip = ""
            item["errors"].append(f"IP '{r['ip']}' is not a valid IPv4 address")
        ver_txt = r["version"]
        v = find_version(term, ver_txt) if ver_txt and ver_txt.lower() not in ("na", "n/a", "-") \
            else None
        if ver_txt and not v and ver_txt.lower() not in ("na", "n/a", "-"):
            item["errors"].append(f"version '{ver_txt}' not found")
        old = current.get(r["crane"])
        new = {"crane": r["crane"], "terminal": term, "port": port, "ip": ip,
               "version_id": v["id"] if v else (old or {}).get("version_id"),
               "enabled": r["enabled"] if r["enabled"] is not None
               else bool((old or {}).get("enabled", True)),
               "notes": r["notes"] or (old or {}).get("notes", "")}
        new["version_name"] = (v or {}).get("name") or (old or {}).get("version_name")
        item["new"] = new
        if old:
            for k, label in (("terminal", "terminal"), ("port", "port"), ("ip", "IP"),
                             ("version_id", "version"), ("enabled", "enabled")):
                ov, nv = old.get(k), new.get(k)
                if k == "enabled":
                    ov, nv = bool(ov), bool(nv)
                if str(ov or "") != str(nv or ""):
                    if k == "version_id":
                        ov, nv = old.get("version_name"), new.get("version_name")
                    item["changes"].append(f"{label}: {ov if ov not in (None, '') else '-'} → "
                                           f"{nv if nv not in (None, '') else '-'}")
            item["status"] = "changed" if item["changes"] else "unchanged"
        else:
            item["status"] = "new"
        final[r["crane"]] = new
        result.append(item)
    names_in = {r["crane"] for r in rows_in}
    dup = {n for n in names_in if sum(1 for r in rows_in if r["crane"] == n) > 1}
    removed = []
    if remove_missing:
        for k in list(final):
            if k not in names_in:
                removed.append(k)
                del final[k]
    for item in result:
        if item["crane"] in dup:
            item["errors"].append("crane listed more than once in the file")
        errs, warns = validate_crane(item["new"], list(final.values()), s)
        item["errors"] += [e for e in errs if e not in item["errors"]]
        item["warnings"] += warns
        if item["errors"]:
            item["status"] = "problem"
    summary = {k: sum(1 for i in result if i["status"] == k)
               for k in ("new", "changed", "unchanged", "problem")}
    summary["removed"] = len(removed)
    return {"items": result, "removed": removed, "summary": summary}


def import_apply(preview, reason):
    backup("Excel import")
    applied = 0
    for item in preview["items"]:
        if item["status"] not in ("new", "changed"):
            continue
        n = item["new"]
        upsert(n, reason, action="Import crane", make_backup=False)
        applied += 1
    for crane in preview["removed"]:
        delete(crane, reason, make_backup=False)
    db.audit("Excel import applied", f"{applied} cranes", reason)
    return applied
