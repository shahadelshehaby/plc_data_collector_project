"""
exporter.py
===========
Background Excel / CSV exports from InfluxDB.

Options (spec):
    cranes        list of crane IDs
    start, stop   Dubai date-times
    from_time, to_time   optional window on every day, e.g. "10:00", "12:00"
    fields        list (empty = all fields of the cranes' versions)
    window        raw / 10s / 30s / 1m / 5m / 15m / 1h
    fn            mean (numbers averaged, the rest last value) / last / max / min
    layout        sheet_per_crane | file_per_crane_day | combined
    format        xlsx | csv
    time_style    local (Dubai time column) | influx (_time in UTC, like an InfluxDB download)
    plctime       include the PLCTime text column (default yes)

Files are named <CRANE>_<YYYY-MM-DD>.xlsx where one file holds one crane-day,
the same naming Gantry Watch reads. Excel's row limit (1,048,576) is
respected: a sheet that would pass it continues on a new sheet.
"""
import csv
import io
import json
import threading
import time
import traceback
import zipfile
from datetime import datetime

from . import config as C
from . import db, query

EXCEL_MAX_ROWS = 1_048_575            # + header
_jobs_lock = threading.Lock()
_running = {}


def start(spec):
    jid = db.execute("INSERT INTO exports(ts,spec,status,progress,message) VALUES(?,?,?,?,?)",
                     (time.time(), json.dumps(spec), "queued", 0, "waiting"))
    t = threading.Thread(target=_run, args=(jid, spec), name=f"export-{jid}", daemon=True)
    with _jobs_lock:
        _running[jid] = t
    t.start()
    return jid


def _update(jid, **kw):
    sets = ", ".join(f"{k}=?" for k in kw)
    db.execute(f"UPDATE exports SET {sets} WHERE id=?", (*kw.values(), jid))


def list_jobs(limit=20):
    out = db.rows("SELECT * FROM exports ORDER BY id DESC LIMIT ?", (limit,))
    for j in out:
        j["spec"] = json.loads(j["spec"] or "{}")
    return out


def download_name(stored):
    """Stored files are '<job>__<name>'; the download keeps only <name>."""
    return stored.split("__", 1)[-1]


def cleanup(keep=20):
    old = db.rows("SELECT id, file FROM exports ORDER BY id DESC LIMIT -1 OFFSET ?", (keep,))
    for j in old:
        if j["file"]:
            (C.EXPORT_DIR / j["file"]).unlink(missing_ok=True)
        db.execute("DELETE FROM exports WHERE id=?", (j["id"],))


def _columns(spec, cat):
    fields = spec.get("fields") or list(cat)
    fields = [f for f in fields if f != "PLCTime"]
    lead = ["_time", "crane_id"] if spec.get("time_style") == "influx" else \
        ["Time (Dubai)", "Crane"]
    if spec.get("plctime", True):
        lead.append("PLCTime")
    return lead, fields


def _row_values(r, spec, lead, fields):
    t = r.get("_time")
    if spec.get("time_style") == "influx":
        tv = t.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" if isinstance(t, datetime) else t
    else:
        tv = t.astimezone(C.LOCAL_TZ).replace(tzinfo=None) if isinstance(t, datetime) else t
    vals = [tv, r.get("crane_id")]
    if "PLCTime" in lead:
        vals.append(r.get("PLCTime"))
    return vals + [r.get(f) for f in fields]


class _XlsxBook:
    def __init__(self):
        import openpyxl
        self.wb = openpyxl.Workbook(write_only=True)
        self.sheets = {}

    def add_rows(self, base_name, header, rows_iter):
        n = 0
        part, ws, count = 1, None, 0
        for vals in rows_iter:
            if ws is None or count >= EXCEL_MAX_ROWS:
                title = base_name if part == 1 else f"{base_name} ({part})"
                ws = self.wb.create_sheet(title[:31])
                ws.append(header)
                part += 1
                count = 0
            ws.append(vals)
            count += 1
            n += 1
        if ws is None:
            ws = self.wb.create_sheet(base_name[:31])
            ws.append(header)
        return n

    def bytes(self):
        buf = io.BytesIO()
        self.wb.save(buf)
        return buf.getvalue()


def _csv_bytes(header, rows_iter):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    n = 0
    for vals in rows_iter:
        w.writerow(["" if v is None else (v.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                                          if isinstance(v, datetime) else v) for v in vals])
        n += 1
    return buf.getvalue().encode("utf-8-sig"), n


def _run(jid, spec):
    try:
        _update(jid, status="running", message="starting")
        cranes = [c.upper() for c in spec["cranes"]]
        cat = query.field_catalog(cranes)
        lead, fields = _columns(spec, cat)
        header = lead + fields
        chunks = query.day_chunks(spec["start"], spec["stop"], spec.get("from_time"),
                                  spec.get("to_time"))
        if not chunks:
            raise ValueError("the chosen dates / time window contain no time")
        total = len(chunks) * len(cranes)
        fmt = spec.get("format", "xlsx")
        layout = spec.get("layout", "sheet_per_crane")
        done, rows_total = 0, 0
        stamp = datetime.now(C.LOCAL_TZ).strftime("%Y%m%d_%H%M%S")
        qfields = fields + (["PLCTime"] if "PLCTime" in lead else [])

        def fetch(crane, s, e):
            sp = {"cranes": [crane], "fields": qfields, "start": s, "stop": e,
                  "window": spec.get("window", "raw"), "fn": spec.get("fn", "mean")}
            for r in query.iter_rows(query.build_flux(sp)):
                yield _row_values(r, spec, lead, fields)

        def progress(msg):
            _update(jid, progress=round(100 * done / total, 1), rows=rows_total, message=msg)

        out_name = None
        if layout == "file_per_crane_day" or (fmt == "csv" and layout == "sheet_per_crane"):
            out_name = f"{jid}__export_{stamp}.zip"
            with zipfile.ZipFile(C.EXPORT_DIR / out_name, "w", zipfile.ZIP_DEFLATED) as z:
                for crane in cranes:
                    if layout == "sheet_per_crane":            # csv: one file per crane
                        def all_days(c=crane):
                            for _d, s, e in chunks:
                                yield from fetch(c, s, e)
                        progress(f"{crane}")
                        data, n = _csv_bytes(header, all_days())
                        z.writestr(f"{crane}_{chunks[0][0]}_to_{chunks[-1][0]}.csv", data)
                        rows_total += n
                        done += len(chunks)
                        continue
                    for day, s, e in chunks:
                        progress(f"{crane} {day}")
                        if fmt == "csv":
                            data, n = _csv_bytes(header, fetch(crane, s, e))
                            z.writestr(f"{crane}_{day}.csv", data)
                        else:
                            book = _XlsxBook()
                            n = book.add_rows(crane, header, fetch(crane, s, e))
                            z.writestr(f"{crane}_{day}.xlsx", book.bytes())
                        rows_total += n
                        done += 1
        else:
            ext = "xlsx" if fmt == "xlsx" else "csv"
            single = len(cranes) == 1 and len(chunks) == 1
            out_name = (f"{jid}__{cranes[0]}_{chunks[0][0]}.{ext}" if single else
                        f"{jid}__export_{stamp}.{ext}")

            def crane_rows(crane):
                nonlocal done
                for day, s, e in chunks:
                    progress(f"{crane} {day}")
                    yield from fetch(crane, s, e)
                    done += 1

            if fmt == "csv":                                   # combined csv
                def every():
                    for c in cranes:
                        yield from crane_rows(c)
                data, rows_total = _csv_bytes(header, every())
                (C.EXPORT_DIR / out_name).write_bytes(data)
            else:
                book = _XlsxBook()
                if layout == "combined":
                    def every():
                        for c in cranes:
                            yield from crane_rows(c)
                    rows_total = book.add_rows("Data", header, every())
                else:
                    for c in cranes:
                        rows_total += book.add_rows(c, header, crane_rows(c))
                (C.EXPORT_DIR / out_name).write_bytes(book.bytes())
        _update(jid, status="done", progress=100, rows=rows_total, file=out_name,
                message=f"{rows_total:,} rows")
        cleanup()
    except Exception as exc:                                   # noqa: BLE001
        _update(jid, status="failed", message=str(exc)[:500])
        traceback.print_exc()
    finally:
        with _jobs_lock:
            _running.pop(jid, None)
