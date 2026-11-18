"""
dashboard.py - figures for the Dashboard / daily digest (from the local store).
"""
from datetime import datetime, timedelta

from . import config as C
from . import db, registry
from .insights import quality_score


def _days(date, n):
    d = datetime.strptime(date, "%Y-%m-%d")
    return [(d - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(n - 1, -1, -1)]


def build(terminal=None, date=None):
    s = C.load_settings()
    date = date or C.local_now().strftime("%Y-%m-%d")
    cranes = registry.list_cranes(terminal)
    names = [c["crane"] for c in cranes]
    ph = ",".join("?" * len(names)) or "''"
    stats = {r["crane"]: r for r in db.rows(
        f"SELECT * FROM daily_stats WHERE date=? AND crane IN ({ph})", (date, *names))}
    days = _days(date, 7)
    week = db.rows(f"SELECT date, crane, received, written, active_sec FROM daily_stats "
                   f"WHERE date>=? AND date<=? AND crane IN ({ph})", (days[0], date, *names))
    ins = db.rows(f"SELECT crane, type, message, count, ts FROM insights WHERE date=? AND crane "
                  f"IN ({ph}) ORDER BY ts DESC", (date, *names))
    alarms = db.rows(f"SELECT crane, type, COUNT(*) n FROM events WHERE severity='alarm' AND "
                     f"ts>=? AND crane IN ({ph}) GROUP BY crane, type",
                     (datetime.strptime(days[0], "%Y-%m-%d").replace(tzinfo=C.LOCAL_TZ)
                      .timestamp(), *names))
    rows = []
    for c in cranes:
        st = stats.get(c["crane"], {})
        q = quality_score(st, bool(c["enabled"]))
        rows.append({
            "crane": c["crane"], "terminal": c["terminal"], "port": c["port"], "ip": c["ip"],
            "version": c["version_name"], "program": c["program"],
            "expected_program": registry.expected_program(c["crane"], c["terminal"]),
            "enabled": bool(c["enabled"]),
            "received": st.get("received", 0), "written": st.get("written", 0),
            "dropped_ip": st.get("dropped_ip", 0), "wrong_size": st.get("wrong_size", 0),
            "active_hours": round((st.get("active_sec") or 0) / 3600, 2),
            "moves": st.get("moves", 0), "first_ts": st.get("first_ts"),
            "last_ts": st.get("last_ts"), "quality": q["score"], "quality_notes": q["notes"],
            "insights": [i for i in ins if i["crane"] == c["crane"]][:5],
            "alarms_7d": sum(a["n"] for a in alarms if a["crane"] == c["crane"]),
        })
    by_day = {d: {"received": 0, "written": 0, "active_sec": 0} for d in days}
    for w in week:
        for k in ("received", "written", "active_sec"):
            by_day[w["date"]][k] += w[k] or 0
    versions = {}
    for c in cranes:
        k = f"{c['program']} {c['version_name']}" if c["version_name"] else "-"
        versions[k] = versions.get(k, 0) + 1
    # coverage grid: lanes x crane numbers
    grids = {}
    for t, cfg in s["terminals"].items():
        if terminal and t != terminal:
            continue
        reg = {c["crane"]: c for c in registry.list_cranes(t)}
        digit = t[-1]
        counts = cfg.get("lane_counts") or {}
        lanes = sorted(set(cfg["lanes"]) | {k[0] for k in reg if k[1:2] == digit})
        lane_n = {lane: max([int(counts.get(lane, cfg.get("cranes_per_lane", 14)))] +
                            [registry.parse_crane_id(k)["number"] for k in reg
                             if k[0] == lane and k[1:2] == digit]) for lane in lanes}
        n_max = max(lane_n.values() or [0])
        grid = []
        for lane in lanes:
            row = []
            for n in range(1, lane_n[lane] + 1):
                cid = f"{lane}{digit}{n:02d}"
                c = reg.get(cid)
                row.append({"crane": cid, "program": registry.expected_program(cid, t, s),
                            "status": "none" if not c else
                            ("collecting" if c["enabled"] else "off")})
            grid.append({"lane": lane, "cells": row})
        # cranes registered under this terminal whose ID belongs elsewhere (e.g. F209 on T4)
        extra = [k for k in reg if not k[1:2] == digit]
        grids[t] = {"grid": grid, "extra": extra, "columns": n_max}
    q = [r["quality"] for r in rows if r["quality"] is not None]
    return {
        "date": date, "terminal": terminal,
        "totals": {"registered": len(cranes),
                   "enabled": sum(1 for c in cranes if c["enabled"]),
                   "with_data_today": sum(1 for r in rows if r["received"]),
                   "packets_today": sum(r["received"] for r in rows),
                   "written_today": sum(r["written"] for r in rows),
                   "active_hours": round(sum(r["active_hours"] for r in rows), 1),
                   "moves": sum(r["moves"] for r in rows),
                   "quality_avg": round(sum(q) / len(q)) if q else None,
                   "insights": len(ins)},
        "versions": versions, "cranes": rows,
        "week": [{"date": d, **by_day[d]} for d in days],
        "coverage": grids,
        "insights": ins[:50],
    }
