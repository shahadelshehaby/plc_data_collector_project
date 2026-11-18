"""
db.py
=====
Local SQLite store (data/manager.db). Holds the crane register, packet
versions, alarms/events history, audit log, daily statistics, insights,
saved queries and export jobs. Nothing here is ever written to InfluxDB.

Both the collector service and the platform open this file. WAL mode and a
busy timeout make that safe; every write is a short transaction.
"""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from . import config as C

SCHEMA = """
CREATE TABLE IF NOT EXISTS cranes (
    crane      TEXT PRIMARY KEY,
    terminal   TEXT NOT NULL,
    port       INTEGER,
    ip         TEXT,
    version_id INTEGER,
    enabled    INTEGER NOT NULL DEFAULT 1,
    notes      TEXT DEFAULT '',
    created    REAL,
    updated    REAL
);
CREATE TABLE IF NOT EXISTS versions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal    TEXT NOT NULL,
    name        TEXT NOT NULL,
    base_id     INTEGER,
    packet_size INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    notes       TEXT DEFAULT '',
    created     REAL,
    UNIQUE(terminal, name)
);
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    terminal   TEXT,
    crane      TEXT,
    category   TEXT,          -- Communication / Parsing / Storage / Configuration / System / Action
    type       TEXT,          -- IP_CONFLICT, WRONG_SIZE, INFLUX_WRITE, ...
    severity   TEXT,          -- alarm / warning / info
    message    TEXT,
    key        TEXT,          -- dedupe key for alarms
    active     INTEGER DEFAULT 0,
    acked      INTEGER DEFAULT 0,
    ack_note   TEXT,
    ack_ts     REAL,
    cleared_ts REAL,
    details    TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_active ON events(active, key);
CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL NOT NULL,
    action  TEXT,
    target  TEXT,
    reason  TEXT,
    before  TEXT,
    after   TEXT
);
CREATE TABLE IF NOT EXISTS daily_stats (
    date        TEXT,
    crane       TEXT,
    received    INTEGER DEFAULT 0,
    written     INTEGER DEFAULT 0,
    dropped_ip  INTEGER DEFAULT 0,
    wrong_size  INTEGER DEFAULT 0,
    parse_err   INTEGER DEFAULT 0,
    write_err   INTEGER DEFAULT 0,
    active_sec  REAL DEFAULT 0,
    moves       INTEGER DEFAULT 0,
    dup_sec     INTEGER DEFAULT 0,
    gaps        INTEGER DEFAULT 0,
    max_drift   REAL DEFAULT 0,
    first_ts    REAL,
    last_ts     REAL,
    PRIMARY KEY (date, crane)
);
CREATE TABLE IF NOT EXISTS insights (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      REAL,
    date    TEXT,
    crane   TEXT,
    type    TEXT,
    message TEXT,
    value   REAL,
    count   INTEGER DEFAULT 1,
    UNIQUE(date, crane, type)
);
CREATE TABLE IF NOT EXISTS saved_queries (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT UNIQUE,
    spec    TEXT,
    created REAL
);
CREATE TABLE IF NOT EXISTS exports (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL,
    spec     TEXT,
    status   TEXT,
    progress REAL DEFAULT 0,
    file     TEXT,
    rows     INTEGER DEFAULT 0,
    message  TEXT
);
CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
);
"""

_local = threading.local()


def connect(path=None) -> sqlite3.Connection:
    """One connection per thread (sqlite3 connections are not thread-safe)."""
    path = str(path or C.DB_FILE)
    cache = getattr(_local, "conns", None)
    if cache is None:
        cache = _local.conns = {}
    con = cache.get(path)
    if con is None:
        C.ensure_dirs()
        con = sqlite3.connect(path, timeout=15, isolation_level=None)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA busy_timeout=15000")
        cache[path] = con
    return con


@contextmanager
def tx(path=None):
    con = connect(path)
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def init():
    con = connect()
    con.executescript(SCHEMA)
    from . import layouts            # seed the baseline versions once
    layouts.seed_versions()


def rows(sql, args=()):
    return [dict(r) for r in connect().execute(sql, args).fetchall()]


def one(sql, args=()):
    r = connect().execute(sql, args).fetchone()
    return dict(r) if r else None


def execute(sql, args=()):
    with tx() as con:
        cur = con.execute(sql, args)
        return cur.lastrowid


def meta_get(k, default=None):
    r = one("SELECT v FROM meta WHERE k=?", (k,))
    return json.loads(r["v"]) if r else default


def meta_set(k, v):
    execute("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (k, json.dumps(v)))


# ── Events / alarms ──────────────────────────────────────────────────────────
CATEGORY = {
    "IP_CONFLICT": "Communication", "PORT_BUSY": "Communication", "IDLE": "Communication",
    "WRONG_SIZE": "Parsing", "PARSE_ERROR": "Parsing",
    "INFLUX_WRITE": "Storage", "BUFFERING": "Storage", "DISK": "Storage",
    "SERVICE_DOWN": "System", "SERVICE": "System", "PLATFORM": "System",
    "CONFIG": "Configuration", "PORT_RULE": "Configuration", "MISSING_IP": "Configuration",
    "ACTION": "Action",
}


def add_event(type_, message, severity="info", crane=None, terminal=None, details=None):
    execute("INSERT INTO events(ts,terminal,crane,category,type,severity,message,details) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (time.time(), terminal, crane, CATEGORY.get(type_, "System"), type_, severity,
             message, json.dumps(details) if details else None))


def raise_alarm(key, type_, message, crane=None, terminal=None, severity="alarm", details=None):
    """Create the alarm if it is not already active. Returns True when new."""
    with tx() as con:
        r = con.execute("SELECT id FROM events WHERE active=1 AND key=?", (key,)).fetchone()
        if r:
            con.execute("UPDATE events SET message=?, details=? WHERE id=?",
                        (message, json.dumps(details) if details else None, r["id"]))
            return False
        con.execute("INSERT INTO events(ts,terminal,crane,category,type,severity,message,key,"
                    "active,details) VALUES(?,?,?,?,?,?,?,?,1,?)",
                    (time.time(), terminal, crane, CATEGORY.get(type_, "System"), type_,
                     severity, message, key, json.dumps(details) if details else None))
        return True


def clear_alarm(key, note=None):
    with tx() as con:
        cur = con.execute("UPDATE events SET active=0, cleared_ts=? WHERE active=1 AND key=?",
                          (time.time(), key))
        return cur.rowcount > 0


def active_alarm_keys(prefix=""):
    return {r["key"] for r in rows("SELECT key FROM events WHERE active=1 AND key LIKE ?",
                                   (prefix + "%",))}


def audit(action, target, reason, before=None, after=None):
    execute("INSERT INTO audit(ts,action,target,reason,before,after) VALUES(?,?,?,?,?,?)",
            (time.time(), action, target, reason,
             json.dumps(before, default=str) if before is not None else None,
             json.dumps(after, default=str) if after is not None else None))
    add_event("ACTION", f"{action}: {target}" + (f" - {reason}" if reason else ""), "info",
              crane=target if target and len(target) <= 6 else None)


def cleanup(history_days=90):
    cutoff = time.time() - history_days * 86400
    with tx() as con:
        con.execute("DELETE FROM events WHERE ts<? AND active=0", (cutoff,))
        con.execute("DELETE FROM audit WHERE ts<?", (cutoff,))
        con.execute("DELETE FROM insights WHERE ts<?", (cutoff,))
    day = time.strftime("%Y-%m-%d", time.gmtime(cutoff))
    execute("DELETE FROM daily_stats WHERE date<?", (day,))
