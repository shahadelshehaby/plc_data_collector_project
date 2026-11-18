"""
query.py
========
Read-only queries on InfluxDB for the Data Explorer, Query and Export tabs.
The platform builds the Flux for you (shown in the Query tab so it can be
copied into InfluxDB notebooks). Times in the platform are Dubai time.
"""
import re
from datetime import datetime, timedelta, timezone

from . import config as C
from . import db, layouts
from .influx import client

WINDOWS = {"raw": None, "10s": "10s", "30s": "30s", "1m": "1m", "5m": "5m", "15m": "15m",
           "1h": "1h"}
FORBIDDEN = re.compile(r"\bto\s*\(|\bhttp\.|\bsql\.|experimental|buckets\.|"
                       r"influxdata/influxdb/v1|\bdelete\b|\bsecrets\.", re.I)


def parse_local(s):
    """'2026-11-17T10:00' (Dubai) -> aware UTC datetime."""
    if isinstance(s, datetime):
        d = s
    else:
        s = str(s).strip().replace(" ", "T")
        d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=C.LOCAL_TZ)
    return d.astimezone(timezone.utc)


def rfc(d):
    return d.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def field_catalog(cranes=None):
    """{field: {type, group, influx_type}} for the versions the given cranes run
    (all versions when no crane is given), in layout order."""
    if cranes:
        vids = [r["version_id"] for r in db.rows(
            f"SELECT version_id FROM cranes WHERE crane IN ({','.join('?' * len(cranes))})",
            cranes) if r["version_id"]]
        vs = [layouts.get_version(v) for v in dict.fromkeys(vids)]
    else:
        vs = layouts.all_versions()
    out = {}
    for v in vs:
        if not v:
            continue
        for f in v["fields"]:
            out.setdefault(f["name"], {"type": f["type"], "group": f.get("group") or "Other",
                                       "influx_type": layouts.INFLUX_TYPE[f["type"]],
                                       "unit": f.get("unit", ""),
                                       "description": f.get("description", "")})
    return out


def _or(col, values):
    return " or ".join(f'r["{col}"] == "{v}"' for v in values)


def _clean(names, pattern=r"^[A-Za-z0-9_]+$"):
    bad = [n for n in names if not re.match(pattern, n)]
    if bad:
        raise ValueError(f"invalid name(s): {', '.join(bad)}")
    return names


def build_flux(spec, settings=None):
    """spec: cranes, fields, start, stop (Dubai), window ('raw'/'10s'/...),
    fn ('mean'/'last'/'max'/'min'), limit."""
    s = settings or C.load_settings()
    cranes = _clean([c.upper() for c in spec["cranes"]])
    fields = _clean(list(spec.get("fields") or []))
    if not cranes:
        raise ValueError("choose at least one crane")
    start, stop = parse_local(spec["start"]), parse_local(spec["stop"])
    if stop <= start:
        raise ValueError("the end time must be after the start time")
    window = WINDOWS.get(spec.get("window") or "raw")
    fn = spec.get("fn") or "mean"
    if fn not in ("mean", "last", "max", "min", "first"):
        raise ValueError("unknown aggregate")
    base = (f'from(bucket: "{s["influx_bucket"]}")\n'
            f'  |> range(start: {rfc(start)}, stop: {rfc(stop)})\n'
            f'  |> filter(fn: (r) => r["_measurement"] == "{s["influx_measurement"]}")\n'
            f'  |> filter(fn: (r) => {_or("crane_id", cranes)})\n')
    if fields:
        if len(fields) <= 25:
            base += f'  |> filter(fn: (r) => {_or("_field", fields)})\n'
        else:
            base += ('  |> filter(fn: (r) => contains(value: r["_field"], set: [' +
                     ", ".join(f'"{f}"' for f in fields) + "]))\n")
    tail = ('  |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")\n'
            '  |> drop(columns: ["_start", "_stop", "_measurement"])\n'
            '  |> group(columns: ["crane_id"])\n'
            '  |> sort(columns: ["_time"])')
    if spec.get("limit"):
        tail += f'\n  |> limit(n: {int(spec["limit"])})'
    if not window:
        return base + tail
    cat = field_catalog(cranes)
    chosen = fields or list(cat)
    if fn in ("last", "first"):
        return base + f"  |> aggregateWindow(every: {window}, fn: {fn}, createEmpty: false)\n" + tail
    # mean works on numbers only, max/min not on text: those fields get the last value
    # (this avoids "unsupported input type for mean aggregate: string")
    agg_types = ("float",) if fn == "mean" else ("float", "integer")
    agg = [f for f in chosen if cat.get(f, {}).get("influx_type") in agg_types]
    rest = [f for f in chosen if f not in agg]
    if not rest or not agg:
        use = fn if not rest else "last"
        return base + f"  |> aggregateWindow(every: {window}, fn: {use}, createEmpty: false)\n" + tail
    sel = lambda names: ("  |> filter(fn: (r) => contains(value: r[\"_field\"], set: [" +
                         ", ".join(f'"{x}"' for x in names) + "]))\n")
    parts, tables = [], []
    if agg:
        parts.append("a = data\n" + sel(agg) +
                     f"  |> aggregateWindow(every: {window}, fn: {fn}, createEmpty: false)\n")
        tables.append("a")
    parts.append("b = data\n" + sel(rest) +
                 f"  |> aggregateWindow(every: {window}, fn: last, createEmpty: false)\n")
    tables.append("b")
    return ("data = " + base + "\n" + "\n".join(parts) +
            f"\nunion(tables: [{', '.join(tables)}])\n" + tail)


def iter_rows(flux, settings=None, timeout_ms=120000):
    """Yields dict rows from a pivoted Flux result (_time as aware datetime)."""
    s = settings or C.load_settings()
    with client(s, timeout_ms) as c:
        for rec in c.query_api().query_stream(flux, org=s["influx_org"]):
            v = dict(rec.values)
            v.pop("result", None)
            v.pop("table", None)
            yield v


def run(spec, max_rows=5000):
    flux = build_flux({**spec, "limit": None})
    rows, cols, truncated = [], [], False
    for r in iter_rows(flux):
        if len(rows) >= max_rows:
            truncated = True
            break
        rows.append(r)
    cat = field_catalog(spec["cranes"])
    seen = {}
    for r in rows:
        for k in r:
            seen.setdefault(k, None)
    order = ["_time", "crane_id"] + [f for f in cat if f in seen] + \
            [k for k in seen if k not in cat and k not in ("_time", "crane_id")]
    cols = [c for c in order if c in seen]
    out = []
    for r in rows:
        t = r.get("_time")
        out.append([t.astimezone(C.LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                    if isinstance(t, datetime) else t] + [r.get(c) for c in cols[1:]])
    return {"flux": flux, "columns": ["time (Dubai)"] + cols[1:], "rows": out,
            "truncated": truncated}


def run_flux(flux, max_rows=5000):
    if FORBIDDEN.search(flux):
        raise ValueError("This box is read-only: writing, deleting or calling other systems "
                         "is not allowed here.")
    if "from(" not in flux and "from (" not in flux:
        raise ValueError("A query must start from a bucket: from(bucket: ...)")
    rows, keys, truncated = [], {}, False
    for r in iter_rows(flux):
        if len(rows) >= max_rows:
            truncated = True
            break
        rows.append(r)
        for k in r:
            keys.setdefault(k, None)
    cols = list(keys)
    out = [[(v.astimezone(C.LOCAL_TZ).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
             if isinstance(v, datetime) else v) for v in (r.get(c) for c in cols)] for r in rows]
    return {"columns": cols, "rows": out, "truncated": truncated}


def positions(cranes, start, stop, every="5s"):
    """For Replay on the yard map: gantry / trolley / hoist positions."""
    spec = {"cranes": cranes, "start": start, "stop": stop, "window": every, "fn": "last",
            "fields": ["In_GANTRY1", "In_TROLLEYPOMUX", "In_HOIST", "Step", "WorkorderIdent"]}
    flux = build_flux(spec)
    out = {}
    for r in iter_rows(flux):
        t = r.get("_time")
        out.setdefault(r.get("crane_id"), []).append(
            [t.timestamp() if isinstance(t, datetime) else t, r.get("In_GANTRY1"),
             r.get("In_TROLLEYPOMUX"), r.get("In_HOIST"), r.get("Step")])
    return out


def day_chunks(start, stop, from_time=None, to_time=None):
    """Split [start, stop) (Dubai) in per-day pieces, optionally only a time
    window on every day (e.g. 10:00-12:00)."""
    a = parse_local(start).astimezone(C.LOCAL_TZ)
    z = parse_local(stop).astimezone(C.LOCAL_TZ)
    out = []
    day = a.replace(hour=0, minute=0, second=0, microsecond=0)
    while day < z:
        nxt = day + timedelta(days=1)
        s, e = max(a, day), min(z, nxt)
        if from_time and to_time:
            fh, fm = map(int, from_time.split(":"))
            th, tm = map(int, to_time.split(":"))
            ws = day.replace(hour=fh, minute=fm)
            we = day.replace(hour=th, minute=tm) if (th, tm) > (fh, fm) else nxt.replace(
                hour=th, minute=tm)
            s, e = max(s, ws), min(e, we)
        if e > s:
            out.append((day.strftime("%Y-%m-%d"), s, e))
        day = nxt
    return out
